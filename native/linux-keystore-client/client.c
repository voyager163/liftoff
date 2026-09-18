#define _GNU_SOURCE
#define SECRET_API_SUBJECT_TO_CHANGE
#include <libsecret/secret.h>
#include <errno.h>
#include <limits.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/random.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#include "protocol.h"
#include "parser.h"

typedef struct {
    const char *operation, *address, *guid, *owner, *collection, *item;
    const char *project, *workspace, *enrollment, *start;
    guint32 uid, pid, sid, timeout;
    LkBusAddress bus;
} Request;

typedef struct { SecretService parent; } PrivateService;
typedef struct { SecretServiceClass parent; } PrivateServiceClass;
static GDBusConnection *selected_connection;
static const char *selected_owner;
static GCancellable *cancellable;
static gint finished;
static gint incoming_limit;
static gint64 deadline;
static sigset_t signals;
G_DEFINE_TYPE(PrivateService, private_service, SECRET_TYPE_SERVICE)

/* The pinned open_sync ignores its bus-name argument. Override its constructor's
 * defaults before GInitable runs, using the inherited public GDBusProxy properties. */
static GObject *private_constructor(GType type, guint count, GObjectConstructParam *properties) {
    GObject *object = G_OBJECT_CLASS(private_service_parent_class)->constructor(type, count, properties);
    g_object_set(object, "g-bus-type", G_BUS_TYPE_NONE, "g-connection", selected_connection,
        "g-name", selected_owner, "g-flags",
        G_DBUS_PROXY_FLAGS_DO_NOT_AUTO_START | G_DBUS_PROXY_FLAGS_DO_NOT_LOAD_PROPERTIES |
        G_DBUS_PROXY_FLAGS_DO_NOT_CONNECT_SIGNALS, NULL);
    return object;
}

static GVariant *reject_prompt_sync(SecretService *self, SecretPrompt *prompt,
        GCancellable *cancel, const GVariantType *type, GError **error) {
    (void)self; (void)prompt; (void)cancel; (void)type;
    g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_PERMISSION_DENIED, "prompt-forbidden");
    return NULL;
}

static void reject_prompt_async(SecretService *self, SecretPrompt *prompt,
        const GVariantType *type, GCancellable *cancel, GAsyncReadyCallback callback, gpointer data) {
    (void)prompt; (void)type;
    GTask *task = g_task_new(self, cancel, callback, data);
    g_task_return_new_error(task, G_IO_ERROR, G_IO_ERROR_PERMISSION_DENIED, "prompt-forbidden");
    g_object_unref(task);
}

static GVariant *reject_prompt_finish(SecretService *self, GAsyncResult *result, GError **error) {
    (void)self;
    return g_task_propagate_pointer(G_TASK(result), error);
}

static void private_service_class_init(PrivateServiceClass *klass) {
    G_OBJECT_CLASS(klass)->constructor = private_constructor;
    SECRET_SERVICE_CLASS(klass)->prompt_sync = reject_prompt_sync;
    SECRET_SERVICE_CLASS(klass)->prompt_async = reject_prompt_async;
    SECRET_SERVICE_CLASS(klass)->prompt_finish = reject_prompt_finish;
}
static void private_service_init(PrivateService *self) { (void)self; }

static void suppress_log(const gchar *domain, GLogLevelFlags level, const gchar *message, gpointer data) {
    (void)domain; (void)level; (void)message; (void)data;
}
static GLogWriterOutput suppress_writer(GLogLevelFlags level, const GLogField *fields, gsize count, gpointer data) {
    (void)level; (void)fields; (void)count; (void)data;
    return G_LOG_WRITER_HANDLED;
}

static gpointer cancellation_watch(gpointer data) {
    (void)data;
    while (!g_atomic_int_get(&finished)) {
        struct timespec pause = { 0, 20000000 };
        int received = sigtimedwait(&signals, NULL, &pause);
        if (received == SIGINT || received == SIGTERM || g_get_monotonic_time() >= deadline) {
            g_cancellable_cancel(cancellable);
            break;
        }
    }
    return NULL;
}

static gboolean identifier(const char *value, size_t maximum) {
    size_t length = strlen(value);
    if (!length || length > maximum) return FALSE;
    for (size_t i = 0; i < length; i++)
        if (!(g_ascii_isalnum(value[i]) || value[i] == '-' || value[i] == '_')) return FALSE;
    return TRUE;
}
static gboolean decimal(const char *text, guint32 *value) {
    if (!*text || strlen(text) > 10) return FALSE;
    for (const char *at = text; *at; at++) if (!g_ascii_isdigit(*at)) return FALSE;
    char *end = NULL;
    errno = 0;
    unsigned long number = strtoul(text, &end, 10);
    if (errno || *end || number > INT_MAX) return FALSE;
    *value = (guint32)number;
    return TRUE;
}
static gboolean item_path(const char *item) {
    size_t prefix = strlen(LK_COLLECTION);
    return strlen(item) > prefix + 1 && strlen(item) <= 256 &&
        !strncmp(item, LK_COLLECTION "/", prefix + 1) &&
        identifier(item + prefix + 1, 128) && !strchr(item + prefix + 1, '-');
}
static gboolean parse_request(int argc, char **argv, Request *r) {
    if (argc != 15) return FALSE;
    size_t total = 0;
    for (int i = 1; i < argc; i++) { size_t n = strnlen(argv[i], 513); if (n > 512) return FALSE; total += n; }
    if (total > 4096) return FALSE;
    *r = (Request){ .operation = argv[1], .address = argv[2], .guid = argv[3], .owner = argv[4],
        .start = argv[8], .collection = argv[9], .item = argv[10], .project = argv[11],
        .workspace = argv[12], .enrollment = argv[13] };
    if ((strcmp(r->operation, "read") && strcmp(r->operation, "create")) ||
        !lk_parse_bus_address(r->address, r->guid, &r->bus) ||
        !g_dbus_is_guid(r->guid) || !g_dbus_is_unique_name(r->owner) ||
        strcmp(r->collection, LK_COLLECTION) || !lk_project_identifier(r->project) ||
        !g_uuid_string_is_valid(r->workspace) || !g_uuid_string_is_valid(r->enrollment) ||
        !decimal(argv[5], &r->uid) || !decimal(argv[6], &r->pid) || !r->pid ||
        !decimal(argv[7], &r->sid) || !r->sid || !decimal(argv[14], &r->timeout) ||
        !r->timeout || r->timeout > 20000 || r->uid != getuid() || getuid() != geteuid()) return FALSE;
    if (!*r->start || strlen(r->start) > 20) return FALSE;
    for (const char *at = r->start; *at; at++) if (!g_ascii_isdigit(*at)) return FALSE;
    return !strcmp(r->operation, "read") ? item_path(r->item) : !strcmp(r->item, "-");
}

static gboolean socket_identity(const Request *r, struct stat *snapshot) {
    const char *name = r->bus.path;
    char resolved[PATH_MAX];
    struct stat entry, parent;
    g_autofree char *directory = g_path_get_dirname(name);
    if (!realpath(name, resolved) || strcmp(name, resolved) || lstat(name, &entry) ||
        !S_ISSOCK(entry.st_mode) || entry.st_uid != r->uid ||
        !realpath(directory, resolved) || strcmp(directory, resolved) ||
        lstat(directory, &parent) || !S_ISDIR(parent.st_mode) ||
        parent.st_uid != r->uid || (parent.st_mode & 077)) return FALSE;
    if (snapshot->st_ino && (snapshot->st_dev != entry.st_dev || snapshot->st_ino != entry.st_ino ||
        snapshot->st_ctim.tv_sec != entry.st_ctim.tv_sec || snapshot->st_ctim.tv_nsec != entry.st_ctim.tv_nsec)) return FALSE;
    *snapshot = entry;
    return TRUE;
}

static GVariant *call(GDBusConnection *bus, const char *destination, const char *path,
        const char *interface, const char *method, GVariant *parameters, const GVariantType *type) {
    g_autoptr(GError) error = NULL;
    gint64 remaining = (deadline - g_get_monotonic_time()) / 1000;
    if (remaining <= 0 || g_cancellable_is_cancelled(cancellable)) return NULL;
    return g_dbus_connection_call_sync(bus, destination, path, interface, method, parameters, type,
        G_DBUS_CALL_FLAGS_NO_AUTO_START, (gint)remaining, cancellable, &error);
}

static gboolean daemon_identity(const Request *r) {
    char filename[64], bytes[4097];
    snprintf(filename, sizeof(filename), "/proc/%u/stat", r->pid);
    FILE *stream = fopen(filename, "re");
    if (!stream) return FALSE;
    size_t length = fread(bytes, 1, sizeof(bytes) - 1, stream);
    gboolean complete = feof(stream) && !ferror(stream);
    fclose(stream);
    if (!complete || !length) return FALSE;
    bytes[length] = 0;
    char *end = strrchr(bytes, ')');
    if (!end || end[1] != ' ') return FALSE;
    char *state = NULL, *field = strtok_r(end + 2, " ", &state);
    for (int number = 3; field && number < 22; number++) field = strtok_r(NULL, " ", &state);
    return field && !strcmp(field, r->start) && getsid((pid_t)r->pid) == (pid_t)r->sid;
}

static gboolean binding(const Request *r, GDBusConnection *bus, struct stat *socket) {
    if (!socket_identity(r, socket) || !daemon_identity(r) || g_dbus_connection_is_closed(bus) ||
        g_strcmp0(g_dbus_connection_get_guid(bus), r->guid)) return FALSE;
    g_autoptr(GVariant) owner = call(bus, "org.freedesktop.DBus", "/org/freedesktop/DBus",
        "org.freedesktop.DBus", "GetNameOwner", g_variant_new("(s)", "org.freedesktop.secrets"), G_VARIANT_TYPE("(s)"));
    g_autoptr(GVariant) credentials = call(bus, "org.freedesktop.DBus", "/org/freedesktop/DBus",
        "org.freedesktop.DBus", "GetConnectionCredentials", g_variant_new("(s)", r->owner), G_VARIANT_TYPE("(a{sv})"));
    if (!owner || !credentials) return FALSE;
    const gchar *observed_owner;
    g_variant_get(owner, "(&s)", &observed_owner);
    g_autoptr(GVariant) fields = g_variant_get_child_value(credentials, 0);
    guint32 uid, pid;
    return !strcmp(observed_owner, r->owner) &&
        g_variant_lookup(fields, "UnixUserID", "u", &uid) && uid == r->uid &&
        g_variant_lookup(fields, "ProcessID", "u", &pid) && pid == r->pid;
}

static GDBusMessage *bounded_messages(GDBusConnection *connection, GDBusMessage *message,
        gboolean incoming, gpointer data) {
    (void)connection; (void)data;
    GVariant *body = g_dbus_message_get_body(message);
    if (incoming && body && g_variant_get_size(body) > 65536) {
        g_atomic_int_set(&incoming_limit, 1);
        g_cancellable_cancel(cancellable);
        g_object_unref(message);
        return NULL;
    }
    return message;
}

static gboolean encrypted(SecretService *service) {
    return !g_strcmp0(secret_service_get_session_algorithms(service), LK_ALGORITHM);
}

static gboolean exact_attributes(GVariant *attributes, GHashTable *expected) {
    if (!attributes || !g_variant_is_of_type(attributes, G_VARIANT_TYPE("a{ss}")) ||
        g_variant_n_children(attributes) != 4) return FALSE;
    GHashTableIter iter;
    gpointer key, value;
    g_hash_table_iter_init(&iter, expected);
    while (g_hash_table_iter_next(&iter, &key, &value)) {
        const char *observed = NULL;
        if (!g_variant_lookup(attributes, key, "&s", &observed) || strcmp(observed, value)) return FALSE;
    }
    return TRUE;
}

static GVariant *item_metadata(const Request *r, GDBusConnection *bus, const char *item, GHashTable *attributes) {
    g_autoptr(GVariant) reply = call(bus, r->owner, item, "org.freedesktop.DBus.Properties",
        "GetAll", g_variant_new("(s)", "org.freedesktop.Secret.Item"), G_VARIANT_TYPE("(a{sv})"));
    if (!reply) return NULL;
    g_autoptr(GVariant) fields = g_variant_get_child_value(reply, 0);
    g_autoptr(GVariant) attrs = g_variant_lookup_value(fields, "Attributes", G_VARIANT_TYPE("a{ss}"));
    gboolean locked;
    guint64 created, modified;
    if (!g_variant_lookup(fields, "Locked", "b", &locked) || locked ||
        !g_variant_lookup(fields, "Created", "t", &created) || !g_variant_lookup(fields, "Modified", "t", &modified) ||
        !exact_attributes(attrs, attributes)) return NULL;
    return g_variant_ref(fields);
}

static gboolean collection_unlocked(const Request *r, GDBusConnection *bus) {
    g_autoptr(GVariant) reply = call(bus, r->owner, r->collection, "org.freedesktop.DBus.Properties",
        "Get", g_variant_new("(ss)", "org.freedesktop.Secret.Collection", "Locked"), G_VARIANT_TYPE("(v)"));
    if (!reply) return FALSE;
    g_autoptr(GVariant) boxed = g_variant_get_child_value(reply, 0);
    g_autoptr(GVariant) value = g_variant_get_variant(boxed);
    return g_variant_is_of_type(value, G_VARIANT_TYPE_BOOLEAN) && !g_variant_get_boolean(value);
}

static gboolean matching(SecretCollection *collection, GHashTable *attributes, const char *expected) {
    g_autoptr(GError) error = NULL;
    g_auto(GStrv) paths = secret_collection_search_for_dbus_paths_sync(collection, NULL, attributes, cancellable, &error);
    if (!paths || error) return FALSE;
    return expected ? paths[0] && !paths[1] && !strcmp(paths[0], expected) : !paths[0];
}

static unsigned char *key_allocate(void) {
    long page = sysconf(_SC_PAGESIZE);
    if (page < 4096) return NULL;
    unsigned char *mapping = mmap(NULL, (size_t)page * 3, PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (mapping == MAP_FAILED) return NULL;
    unsigned char *key = mapping + page;
    if (mprotect(key, (size_t)page, PROT_READ | PROT_WRITE) || mlock(key, (size_t)page) ||
        madvise(key, (size_t)page, MADV_DONTDUMP)) {
        munmap(mapping, (size_t)page * 3);
        return NULL;
    }
    return key;
}
static void key_free(gpointer value) {
    if (!value) return;
    size_t page = (size_t)sysconf(_SC_PAGESIZE);
    lk_clear(value, page);
    munlock(value, page);
    munmap((unsigned char *)value - page, page * 3);
}
static gboolean random_key(unsigned char *key) {
    size_t have = 0;
    while (have < LK_KEY_BYTES && !g_cancellable_is_cancelled(cancellable)) {
        ssize_t count = getrandom(key + have, LK_KEY_BYTES - have, GRND_NONBLOCK);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return FALSE;
        have += (size_t)count;
    }
    return have == LK_KEY_BYTES;
}
static gboolean read_key(SecretService *service, const char *item, unsigned char *destination) {
    if (!encrypted(service)) return FALSE;
    const char *paths[] = { item, NULL };
    g_autoptr(GError) error = NULL;
    g_autoptr(GHashTable) secrets = secret_service_get_secrets_for_dbus_paths_sync(service, paths, cancellable, &error);
    if (!secrets || error || g_hash_table_size(secrets) != 1) return FALSE;
    SecretValue *value = g_hash_table_lookup(secrets, item);
    if (!value || g_strcmp0(secret_value_get_content_type(value), "application/octet-stream")) return FALSE;
    gsize length = 0;
    const char *bytes = secret_value_get(value, &length);
    if (!bytes || length != LK_KEY_BYTES) return FALSE;
    memcpy(destination, bytes, LK_KEY_BYTES);
    return TRUE;
}

static int execute(const Request *r) {
    enum lk_error code = LK_TRANSPORT;
    enum lk_effect effect = LK_NO_DISPATCH;
    struct stat socket = {0};
    g_autoptr(GError) error = NULL;
    g_autoptr(GDBusConnection) bus = NULL;
    g_autoptr(SecretService) service = NULL;
    g_autoptr(SecretCollection) collection = NULL;
    g_autoptr(GHashTable) attributes = g_hash_table_new(g_str_hash, g_str_equal);
    g_autoptr(GHashTable) properties = NULL;
    g_autoptr(SecretValue) generated = NULL;
    g_autoptr(GVariant) before = NULL;
    g_autoptr(GVariant) after = NULL;
    g_autofree char *created = NULL;
    unsigned char *key = key_allocate(), *check = key_allocate();
    const char *item = !strcmp(r->operation, "read") ? r->item : NULL;
    guint filter = 0;
    if (!key || !check) { code = LK_MEMORY; goto out; }
    if (!socket_identity(r, &socket)) { code = LK_IDENTITY; goto out; }
    bus = g_dbus_connection_new_for_address_sync(r->bus.bound,
        G_DBUS_CONNECTION_FLAGS_AUTHENTICATION_CLIENT | G_DBUS_CONNECTION_FLAGS_MESSAGE_BUS_CONNECTION,
        NULL, cancellable, &error);
    if (!bus) goto out;
    g_dbus_connection_set_exit_on_close(bus, FALSE);
    filter = g_dbus_connection_add_filter(bus, bounded_messages, NULL, NULL);
    if (!binding(r, bus, &socket)) { code = LK_IDENTITY; goto out; }
    selected_connection = bus; selected_owner = r->owner;
    service = secret_service_open_sync(private_service_get_type(), r->owner, SECRET_SERVICE_NONE, cancellable, &error);
    if (!service || g_dbus_proxy_get_connection(G_DBUS_PROXY(service)) != bus ||
        g_strcmp0(g_dbus_proxy_get_name(G_DBUS_PROXY(service)), r->owner) ||
        !(g_dbus_proxy_get_flags(G_DBUS_PROXY(service)) & G_DBUS_PROXY_FLAGS_DO_NOT_AUTO_START)) {
        code = LK_IDENTITY; goto out;
    }
    g_dbus_proxy_set_default_timeout(G_DBUS_PROXY(service), (gint)r->timeout);
    if (!secret_service_ensure_session_sync(service, cancellable, &error) || !encrypted(service)) { code = LK_SESSION; goto out; }
    if (!binding(r, bus, &socket)) { code = LK_IDENTITY; goto out; }
    if (!collection_unlocked(r, bus)) { code = LK_LOCKED; goto out; }
    collection = secret_collection_new_for_dbus_path_sync(service, r->collection, SECRET_COLLECTION_NONE, cancellable, &error);
    if (!collection || g_dbus_proxy_get_connection(G_DBUS_PROXY(collection)) != bus ||
        g_strcmp0(g_dbus_proxy_get_name(G_DBUS_PROXY(collection)), r->owner) ||
        g_strcmp0(g_dbus_proxy_get_object_path(G_DBUS_PROXY(collection)), r->collection)) { code = LK_ITEM; goto out; }
    g_dbus_proxy_set_default_timeout(G_DBUS_PROXY(collection), (gint)r->timeout);
    g_hash_table_insert(attributes, "xdg:schema", "org.liftoff.ManagedApplicationKey.v1");
    g_hash_table_insert(attributes, "liftoff.project", (gpointer)r->project);
    g_hash_table_insert(attributes, "liftoff.workspace", (gpointer)r->workspace);
    g_hash_table_insert(attributes, "liftoff.enrollment", (gpointer)r->enrollment);
    if (!matching(collection, attributes, item)) { code = LK_ITEM; goto out; }
    if (!binding(r, bus, &socket) || !encrypted(service)) { code = LK_IDENTITY; goto out; }
    if (!item) {
        if (!random_key(key)) { code = LK_RANDOM; goto out; }
        generated = secret_value_new_full((gchar *)key, LK_KEY_BYTES, "application/octet-stream", key_free);
        key = NULL;
        properties = g_hash_table_new_full(g_str_hash, g_str_equal, NULL, (GDestroyNotify)g_variant_unref);
        GVariantBuilder builder;
        g_variant_builder_init(&builder, G_VARIANT_TYPE("a{ss}"));
        GHashTableIter iter; gpointer name, value;
        g_hash_table_iter_init(&iter, attributes);
        while (g_hash_table_iter_next(&iter, &name, &value)) g_variant_builder_add(&builder, "{ss}", name, value);
        g_hash_table_insert(properties, "org.freedesktop.Secret.Item.Attributes", g_variant_ref_sink(g_variant_builder_end(&builder)));
        g_hash_table_insert(properties, "org.freedesktop.Secret.Item.Label", g_variant_ref_sink(g_variant_new_string("Liftoff application key")));
        if (!binding(r, bus, &socket) || !encrypted(service) || !matching(collection, attributes, NULL)) { code = LK_IDENTITY; goto out; }
        if (!lk_frame("before-create", LK_POSSIBLE_MUTATION, LK_OK, NULL, NULL)) { code = LK_OUTPUT; goto out; }
        effect = LK_POSSIBLE_MUTATION;
        created = secret_service_create_item_dbus_path_sync(service, r->collection, properties, generated,
            SECRET_ITEM_CREATE_NONE, cancellable, &error);
        if (!created || strlen(created) > 256 || !g_variant_is_object_path(created)) { code = LK_PROVIDER; goto out; }
        item = created;
        effect = LK_RETURNED_IDENTITY;
        if (!lk_frame("created-identity", effect, LK_OK, item, NULL)) { code = LK_OUTPUT; goto out; }
        if (!item_path(item)) { code = LK_ITEM; goto out; }
    }
    if (!binding(r, bus, &socket) || !encrypted(service)) { code = LK_IDENTITY; goto out; }
    if (!matching(collection, attributes, item) || !(before = item_metadata(r, bus, item, attributes))) { code = LK_ITEM; goto out; }
    if (!read_key(service, item, check)) { code = LK_ITEM; goto out; }
    if (generated) {
        const char *original = secret_value_get(generated, NULL);
        unsigned char difference = 0;
        for (size_t i = 0; i < LK_KEY_BYTES; i++) difference |= (unsigned char)original[i] ^ check[i];
        if (difference) { code = LK_ITEM; goto out; }
    } else {
        if (!read_key(service, item, key) || memcmp(key, check, LK_KEY_BYTES)) { code = LK_ITEM; goto out; }
    }
    after = item_metadata(r, bus, item, attributes);
    if (!after || !g_variant_equal(before, after) || !matching(collection, attributes, item)) { code = LK_ITEM; goto out; }
    if (!binding(r, bus, &socket) || !encrypted(service)) { code = LK_IDENTITY; goto out; }
    code = LK_OK;
out:
    if (g_atomic_int_get(&incoming_limit)) code = LK_LIMIT;
    else if (g_cancellable_is_cancelled(cancellable)) code = LK_CANCELLED;
    if (filter) g_dbus_connection_remove_filter(bus, filter);
    int output = lk_frame("result", effect, code, effect == LK_RETURNED_IDENTITY || code == LK_OK ? item : NULL, code == LK_OK ? check : NULL);
    key_free(key); key_free(check);
    selected_connection = NULL; selected_owner = NULL;
    return output && code == LK_OK ? 0 : 1;
}

int main(int argc, char **argv) {
    signal(SIGPIPE, SIG_IGN);
    if (argc == 2 && !strcmp(argv[1], "--contract")) return lk_contract() ? 0 : 1;
    Request request;
    if (!parse_request(argc, argv, &request)) { lk_frame("result", LK_NO_DISPATCH, LK_ARGUMENT, NULL, NULL); return 1; }
    struct stat output;
    for (int descriptor = STDOUT_FILENO; descriptor <= STDERR_FILENO; descriptor++)
        if (fstat(descriptor, &output) || !(S_ISFIFO(output.st_mode) || S_ISSOCK(output.st_mode))) return 1;
    struct rlimit core = {0, 0};
    if (setrlimit(RLIMIT_CORE, &core) || prctl(PR_SET_DUMPABLE, 0, 0, 0, 0)) {
        lk_frame("result", LK_NO_DISPATCH, LK_MEMORY, NULL, NULL); return 1;
    }
    /* Even a rejected constructor binding cannot trigger ordinary bus discovery.
     * Actual operations still require the explicitly created connection object. */
    if (setenv("DBUS_SESSION_BUS_ADDRESS", request.bus.bound, 1) ||
        setenv("SECRET_SERVICE_BUS_NAME", request.owner, 1)) {
        lk_frame("result", LK_NO_DISPATCH, LK_TRANSPORT, NULL, NULL); return 1;
    }
    unsetenv("DBUS_STARTER_ADDRESS"); unsetenv("DBUS_STARTER_BUS_TYPE");
    unsetenv("G_DBUS_DEBUG"); unsetenv("G_MESSAGES_DEBUG");
    g_log_set_default_handler(suppress_log, NULL);
    g_log_set_writer_func(suppress_writer, NULL, NULL);
    sigemptyset(&signals); sigaddset(&signals, SIGINT); sigaddset(&signals, SIGTERM);
    if (pthread_sigmask(SIG_BLOCK, &signals, NULL)) { lk_frame("result", LK_NO_DISPATCH, LK_PLATFORM, NULL, NULL); return 1; }
    cancellable = g_cancellable_new();
    deadline = g_get_monotonic_time() + (gint64)request.timeout * 1000;
    GThread *watch = g_thread_new("keystore-deadline", cancellation_watch, NULL);
    int result = execute(&request);
    g_atomic_int_set(&finished, 1);
    g_thread_join(watch);
    g_clear_object(&cancellable);
    return result;
}
