#ifndef CHANGFU_FUTU_BRIDGE_H
#define CHANGFU_FUTU_BRIDGE_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct ChangFuFutuClient ChangFuFutuClient;

typedef enum ChangFuFutuStatus {
    ChangFuFutuStatusOk = 0,
    ChangFuFutuStatusSdkUnavailable = 1,
    ChangFuFutuStatusInvalidArgument = 2,
    ChangFuFutuStatusConnectionFailed = 3,
    ChangFuFutuStatusOperationFailed = 4,
    ChangFuFutuStatusTimeout = 5
} ChangFuFutuStatus;

ChangFuFutuClient *changfu_futu_create(void);
void changfu_futu_destroy(ChangFuFutuClient *client);
bool changfu_futu_sdk_available(void);

ChangFuFutuStatus changfu_futu_connect(
    ChangFuFutuClient *client,
    const char *host,
    uint16_t port
);

void changfu_futu_disconnect(ChangFuFutuClient *client);
bool changfu_futu_is_connected(const ChangFuFutuClient *client);

ChangFuFutuStatus changfu_futu_load_snapshot_json(
    ChangFuFutuClient *client,
    bool refresh_cache,
    const char *additional_symbols_csv,
    char **json
);

ChangFuFutuStatus changfu_futu_search_instruments_json(
    ChangFuFutuClient *client,
    const char *query,
    const char *markets_csv,
    const char *instrument_types_csv,
    uint32_t limit,
    char **json
);

ChangFuFutuStatus changfu_futu_option_expiries_json(
    ChangFuFutuClient *client,
    const char *underlying_symbol,
    char **json
);

ChangFuFutuStatus changfu_futu_option_chain_json(
    ChangFuFutuClient *client,
    const char *underlying_symbol,
    const char *expiry_date,
    char **json
);

ChangFuFutuStatus changfu_futu_option_quotes_json(
    ChangFuFutuClient *client,
    const char *option_symbols_csv,
    char **json
);

ChangFuFutuStatus changfu_futu_sell_put_underlying_json(
    ChangFuFutuClient *client,
    const char *symbol,
    char **json
);

ChangFuFutuStatus changfu_futu_market_intelligence_json(
    ChangFuFutuClient *client,
    const char *symbols_csv,
    char **json
);

ChangFuFutuStatus changfu_futu_trade_readiness_json(
    ChangFuFutuClient *client,
    const char *account_id,
    const char *symbol,
    const char *side,
    const char *position_effect,
    const char *order_type,
    const char *trading_session,
    const char *time_in_force,
    double quantity,
    double limit_price,
    char **json
);

ChangFuFutuStatus changfu_futu_place_order_json(
    ChangFuFutuClient *client,
    const char *intent_id,
    const char *account_id,
    const char *symbol,
    const char *side,
    const char *position_effect,
    const char *order_type,
    const char *trading_session,
    const char *time_in_force,
    double quantity,
    double limit_price,
    char **json
);

ChangFuFutuStatus changfu_futu_cancel_order_json(
    ChangFuFutuClient *client,
    const char *intent_id,
    const char *account_id,
    const char *broker_order_id,
    const char *symbol,
    char **json
);

ChangFuFutuStatus changfu_futu_find_order_by_intent_json(
    ChangFuFutuClient *client,
    const char *intent_id,
    const char *account_id,
    const char *symbol,
    const char *side,
    double quantity,
    double limit_price,
    char **json
);

void changfu_futu_free_string(char *value);
const char *changfu_futu_last_error(const ChangFuFutuClient *client);

#ifdef __cplusplus
}
#endif

#endif
