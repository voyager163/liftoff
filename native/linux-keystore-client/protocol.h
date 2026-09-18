#ifndef LIFTOFF_KEYSTORE_PROTOCOL_H
#define LIFTOFF_KEYSTORE_PROTOCOL_H
#include <stddef.h>
#include <stdint.h>

#define LK_PROTOCOL "liftoff-linux-keystore-client/1"
#define LK_LIBSECRET_COMMIT "a5cd57f103038c06b64d5f6ebfd0e627bb40af4e"
#define LK_ALGORITHM "dh-ietf1024-sha256-aes128-cbc-pkcs7"
#define LK_COLLECTION "/org/freedesktop/secrets/collection/login"
#define LK_MAX_METADATA 2048u
#define LK_KEY_BYTES 32u

enum lk_effect { LK_NO_DISPATCH, LK_POSSIBLE_MUTATION, LK_RETURNED_IDENTITY };
enum lk_error {
    LK_OK, LK_ARGUMENT, LK_PLATFORM, LK_MEMORY, LK_TRANSPORT, LK_IDENTITY,
    LK_SESSION, LK_LOCKED, LK_ITEM, LK_RANDOM, LK_PROVIDER, LK_CANCELLED,
    LK_OUTPUT, LK_LIMIT
};

void lk_clear(void *bytes, size_t length);
int lk_frame(const char *event, enum lk_effect effect, enum lk_error error,
             const char *item, const unsigned char *key);
int lk_contract(void);
#endif
