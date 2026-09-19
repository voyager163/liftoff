#include "parser.h"
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static int ascii_alnum(unsigned char c) {
    return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

static int hexadecimal(unsigned char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static int valid_utf8_path(const unsigned char *bytes, size_t length) {
    for (size_t i = 0; i < length;) {
        uint32_t value = bytes[i++];
        uint32_t minimum = 0;
        unsigned continuation = 0;
        if (value >= 0xc2 && value <= 0xdf) { value &= 0x1f; continuation = 1; minimum = 0x80; }
        else if (value >= 0xe0 && value <= 0xef) { value &= 0x0f; continuation = 2; minimum = 0x800; }
        else if (value >= 0xf0 && value <= 0xf4) { value &= 0x07; continuation = 3; minimum = 0x10000; }
        else if (value >= 0x80) return 0;
        if (length - i < continuation) return 0;
        while (continuation--) {
            unsigned char next = bytes[i++];
            if ((next & 0xc0) != 0x80) return 0;
            value = (value << 6) | (next & 0x3f);
        }
        if (value < minimum || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff) ||
            value < 0x20 || (value >= 0x7f && value <= 0x9f)) return 0;
    }
    return 1;
}

int lk_parse_bus_address(const char *address, const char *guid, LkBusAddress *result) {
    memset(result, 0, sizeof(*result));
    size_t size = 0;
    while (size <= LK_MAX_ENCODED_ADDRESS && address[size]) size++;
    if (size > LK_MAX_ENCODED_ADDRESS || size <= 10 || strncmp(address, "unix:path=", 10)) return 0;
    size_t guid_size = 0;
    while (guid_size <= 32 && guid[guid_size]) guid_size++;
    if (guid_size != 32) return 0;
    for (size_t i = 0; i < guid_size; i++) if (hexadecimal((unsigned char)guid[i]) < 0) return 0;
    unsigned char path[LK_MAX_SOCKET_BYTES + 1u];
    size_t written = 0;
    for (size_t i = 10; i < size;) {
        unsigned char value = (unsigned char)address[i++];
        if (value == '%') {
            if (size - i < 2) return 0;
            int high = hexadecimal((unsigned char)address[i++]), low = hexadecimal((unsigned char)address[i++]);
            if (high < 0 || low < 0) return 0;
            value = (unsigned char)((high << 4) | low);
        } else if (!(ascii_alnum(value) || value == '_' || value == '-' || value == '/' ||
                     value == '.' || value == '\\')) {
            /* D-Bus separators/extra keys are syntax, never literal path data.
             * Encoded separators remain filename bytes and are not decoded twice. */
            return 0;
        }
        if (written == LK_MAX_SOCKET_BYTES || value == 0) return 0;
        path[written++] = value;
    }
    path[written] = 0;
    if (written < 2 || path[0] != '/' || !valid_utf8_path(path, written)) return 0;
    for (size_t begin = 1, end = 1; end <= written; end++) {
        if (end != written && path[end] != '/') continue;
        size_t length = end - begin;
        if (!length || (length == 1 && path[begin] == '.') ||
            (length == 2 && path[begin] == '.' && path[begin + 1] == '.')) return 0;
        begin = end + 1;
    }
    int bound = snprintf(result->bound, sizeof(result->bound), "%s,guid=%s", address, guid);
    if (bound < 0 || (size_t)bound >= sizeof(result->bound)) {
        memset(result, 0, sizeof(*result));
        return 0;
    }
    memcpy(result->path, path, written + 1);
    return 1;
}

int lk_project_identifier(const char *value) {
    size_t length = 0;
    while (length < 256 && value[length]) {
        unsigned char c = (unsigned char)value[length++];
        if (!(ascii_alnum(c) || c == '_' || c == '.' || c == ':' || c == '@' || c == '/' || c == '-')) return 0;
    }
    return length > 0 && value[length] == 0;
}
