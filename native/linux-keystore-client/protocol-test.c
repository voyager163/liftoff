#include "protocol.h"
#include "parser.h"
#include <string.h>

/* Nonsecret framing fixtures only: never linked to libsecret or a message bus. */
int main(int argc, char **argv) {
    unsigned char bytes[LK_KEY_BYTES];
    memset(bytes, 0xa5, sizeof(bytes));
    if (argc == 4 && !strcmp(argv[1], "address")) {
        LkBusAddress parsed;
        return lk_parse_bus_address(argv[2], "0123456789abcdef0123456789abcdef", &parsed) &&
            !strcmp(parsed.path, argv[3]) ? 0 : 4;
    }
    if (argc == 4 && !strcmp(argv[1], "bound-address")) {
        LkBusAddress parsed;
        return lk_parse_bus_address(argv[2], "0123456789abcdef0123456789abcdef", &parsed) &&
            !strcmp(parsed.bound, argv[3]) ? 0 : 4;
    }
    if (argc == 3 && !strcmp(argv[1], "reject-address")) {
        LkBusAddress parsed;
        return !lk_parse_bus_address(argv[2], "0123456789abcdef0123456789abcdef", &parsed) &&
            !parsed.path[0] && !parsed.bound[0] ? 0 : 4;
    }
    if (argc == 3 && !strcmp(argv[1], "project")) return lk_project_identifier(argv[2]) ? 0 : 4;
    if (argc == 3 && !strcmp(argv[1], "reject-project")) return !lk_project_identifier(argv[2]) ? 0 : 4;
    if (argc != 2) return 2;
    if (!strcmp(argv[1], "contract")) return lk_contract() ? 0 : 3;
    if (!strcmp(argv[1], "create")) {
        if (!lk_frame("before-create", LK_POSSIBLE_MUTATION, LK_OK, NULL, NULL) ||
            !lk_frame("created-identity", LK_RETURNED_IDENTITY, LK_OK, LK_COLLECTION "/42", NULL) ||
            !lk_frame("result", LK_RETURNED_IDENTITY, LK_OK, LK_COLLECTION "/42", bytes)) return 3;
        lk_clear(bytes, sizeof(bytes));
        for (size_t i = 0; i < sizeof(bytes); i++) if (bytes[i]) return 4;
        return 0;
    }
    if (!strcmp(argv[1], "uncertain"))
        return lk_frame("result", LK_POSSIBLE_MUTATION, LK_PROVIDER, NULL, NULL) ? 0 : 3;
    if (!strcmp(argv[1], "post-write"))
        return lk_frame("result", LK_RETURNED_IDENTITY, LK_IDENTITY, LK_COLLECTION "/42", NULL) ? 0 : 3;
    if (!strcmp(argv[1], "reject")) {
        char large[258];
        memset(large, 'x', sizeof(large) - 1); large[sizeof(large) - 1] = 0;
        if (lk_frame("raw-diagnostics", LK_NO_DISPATCH, LK_OK, NULL, NULL) ||
            lk_frame("result", (enum lk_effect)-1, LK_OK, NULL, NULL) ||
            lk_frame("result", LK_NO_DISPATCH, (enum lk_error)99, NULL, NULL) ||
            lk_frame("result", LK_NO_DISPATCH, LK_OK, "/bad\"path", NULL) ||
            lk_frame("result", LK_NO_DISPATCH, LK_OK, large, NULL) ||
            lk_frame("result", LK_NO_DISPATCH, LK_PROVIDER, NULL, bytes)) return 4;
        return 0;
    }
    return 2;
}
