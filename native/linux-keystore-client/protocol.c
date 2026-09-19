#include "protocol.h"
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

void lk_clear(void *bytes, size_t length) {
    volatile unsigned char *cursor = bytes;
    while (length--) *cursor++ = 0;
}

/* Pinned GNOME gkd-secret-secret.c discards the supplied content type and
 * hardcodes this reply label. It is not the encoding of the opaque key bytes. */
int lk_gnome_secret_shape(const char *content_type, size_t length) {
    return content_type && !strcmp(content_type, LK_GNOME_REPLY_CONTENT_TYPE) && length == LK_KEY_BYTES;
}

static int write_all(const void *bytes, size_t length) {
    const unsigned char *cursor = bytes;
    while (length) {
        ssize_t count = write(STDOUT_FILENO, cursor, length);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return 0;
        cursor += count;
        length -= (size_t)count;
    }
    return 1;
}

static int framed(const char *metadata, const unsigned char *key) {
    size_t length = strlen(metadata);
    if (length > LK_MAX_METADATA) return 0;
    unsigned char header[12] = {
        'L', 'K', 'C', '1', (unsigned char)(length >> 24), (unsigned char)(length >> 16),
        (unsigned char)(length >> 8), (unsigned char)length, 0, 0, 0, key ? LK_KEY_BYTES : 0
    };
    return write_all(header, sizeof(header)) && write_all(metadata, length)
        && (!key || write_all(key, LK_KEY_BYTES));
}

int lk_frame(const char *event, enum lk_effect effect, enum lk_error error,
             const char *item, const unsigned char *key) {
    static const char *effects[] = { "no-dispatch", "possible-mutation", "returned-identity" };
    static const char *errors[] = {
        "ok", "invalid-arguments", "unsupported-platform", "memory-protection",
        "transport-unavailable", "identity-changed", "encrypted-session-required",
        "locked", "item-mismatch", "random-unavailable", "provider-failure",
        "cancelled-or-expired", "output-failed", "protocol-limit"
    };
    if (effect < LK_NO_DISPATCH || effect > LK_RETURNED_IDENTITY || error < LK_OK || error > LK_LIMIT ||
        (strcmp(event, "before-create") && strcmp(event, "created-identity") &&
         strcmp(event, "result")) || (key && error != LK_OK)) return 0;
    if (item) {
        size_t length = strlen(item);
        if (length > 256 || length == 0) return 0;
        for (size_t index = 0; index < length; index++) {
            unsigned char c = (unsigned char)item[index];
            if (!(c == '/' || c == '_' || (c >= '0' && c <= '9') ||
                  (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'))) return 0;
        }
    }
    char metadata[LK_MAX_METADATA + 1];
    int length = snprintf(metadata, sizeof(metadata),
        "{\"protocol\":\"%s\",\"event\":\"%s\",\"effect\":\"%s\",\"code\":\"%s\","
        "\"item\":%s%s%s,\"keyBytes\":%u}",
        LK_PROTOCOL, event, effects[effect], errors[error],
        item ? "\"" : "", item ? item : "null", item ? "\"" : "", key ? LK_KEY_BYTES : 0);
    return length > 0 && (size_t)length < sizeof(metadata) && framed(metadata, key);
}

int lk_contract(void) {
    return framed("{\"protocol\":\"" LK_PROTOCOL "\",\"libsecretCommit\":\"" LK_LIBSECRET_COMMIT
        "\",\"daemonSourceCommit\":\"" LK_GNOME_COMMIT
        "\",\"algorithm\":\"" LK_ALGORITHM "\",\"operations\":[\"read\",\"create\"],"
        "\"keyBytes\":32,\"maximumMetadataBytes\":2048,\"authorization\":false,"
        "\"readiness\":false,\"qualification\":\"required\"}", NULL);
}
