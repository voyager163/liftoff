#ifndef LIFTOFF_KEYSTORE_PARSER_H
#define LIFTOFF_KEYSTORE_PARSER_H

#define LK_MAX_SOCKET_BYTES 107u
#define LK_MAX_ENCODED_ADDRESS (10u + 3u * LK_MAX_SOCKET_BYTES)
#define LK_BOUND_ADDRESS_BYTES (LK_MAX_ENCODED_ADDRESS + 6u + 32u + 1u)

typedef struct {
    char path[LK_MAX_SOCKET_BYTES + 1u];
    char bound[LK_BOUND_ADDRESS_BYTES];
} LkBusAddress;

int lk_parse_bus_address(const char *address, const char *guid, LkBusAddress *result);
int lk_project_identifier(const char *value);
#endif
