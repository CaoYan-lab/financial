#include "ChangFuFutuBridge.h"

#if defined(CHANGFU_FUTU_SDK_AVAILABLE)
#include "FTAPIChannel.h"
#include "FTAPI_Define_ProtoID.h"
#include "Proto/Common.pb.h"
#include "Proto/Qot_Common.pb.h"
#include "Proto/Qot_GetBasicQot.pb.h"
#include "Proto/Qot_GetEconomicCalendar.pb.h"
#include "Proto/Qot_GetEarningsCalendar.pb.h"
#include "Proto/Qot_GetFedWatchTargetRate.pb.h"
#include "Proto/Qot_GetKL.pb.h"
#include "Proto/Qot_GetMarketState.pb.h"
#include "Proto/Qot_GetOptionChain.pb.h"
#include "Proto/Qot_GetOptionExpirationDate.pb.h"
#include "Proto/Qot_GetOrderBook.pb.h"
#include "Proto/Qot_GetSearchQuote.pb.h"
#include "Proto/Qot_GetSearchNews.pb.h"
#include "Proto/Qot_GetSecuritySnapshot.pb.h"
#include "Proto/Qot_GetStaticInfo.pb.h"
#include "Proto/Qot_GetTicker.pb.h"
#include "Proto/Qot_Sub.pb.h"
#include "Proto/Trd_Common.pb.h"
#include "Proto/Trd_GetAccList.pb.h"
#include "Proto/Trd_GetFunds.pb.h"
#include "Proto/Trd_GetHistoryOrderFillList.pb.h"
#include "Proto/Trd_GetHistoryOrderList.pb.h"
#include "Proto/Trd_GetMaxTrdQtys.pb.h"
#include "Proto/Trd_GetOrderFillList.pb.h"
#include "Proto/Trd_GetOrderList.pb.h"
#include "Proto/Trd_GetPositionList.pb.h"
#include "Proto/Trd_ModifyOrder.pb.h"
#include "Proto/Trd_PlaceOrder.pb.h"
#include <google/protobuf/message.h>
#include <google/protobuf/struct.pb.h>
#include <google/protobuf/util/json_util.h>
#endif

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cctype>
#include <cmath>
#include <ctime>
#include <cstdlib>
#include <cstring>
#include <iomanip>
#include <map>
#include <mutex>
#include <set>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

struct ChangFuFutuReply {
    int type = 0;
    std::vector<char> data;
};

struct ChangFuFutuAccount {
    unsigned long long id = 0;
    int environment = 0;
    int accountType = 0;
    int accountStatus = 0;
    std::vector<int> markets;
};

struct ChangFuFutuClient {
#if defined(CHANGFU_FUTU_SDK_AVAILABLE)
    FTAPIChannelPtr channel = nullptr;
#endif
    mutable std::mutex mutex;
    std::condition_variable condition;
    bool connectCompleted = false;
    bool connected = false;
    long long connectError = 0;
    std::atomic<unsigned int> tradeSerial{0};
    std::string lastError;
    std::unordered_map<unsigned int, ChangFuFutuReply> replies;
};

#if defined(CHANGFU_FUTU_SDK_AVAILABLE)
namespace {
std::mutex registryMutex;
std::unordered_map<FTAPIChannelPtr, ChangFuFutuClient *> clients;

ChangFuFutuClient *clientForChannel(FTAPIChannelPtr channel) {
    std::lock_guard<std::mutex> lock(registryMutex);
    const auto iterator = clients.find(channel);
    return iterator == clients.end() ? nullptr : iterator->second;
}

void onInitConnect(FTAPIChannelPtr channel, Futu::i64_t errorCode, const char *description) {
    ChangFuFutuClient *client = clientForChannel(channel);
    if (client == nullptr) {
        return;
    }
    {
        std::lock_guard<std::mutex> lock(client->mutex);
        client->connectCompleted = true;
        client->connectError = errorCode;
        client->connected = errorCode == 0;
        client->lastError = errorCode == 0
            ? ""
            : (description == nullptr ? "OpenD 握手失败" : description);
    }
    client->condition.notify_all();
}

void onDisconnect(FTAPIChannelPtr channel, Futu::i64_t errorCode) {
    ChangFuFutuClient *client = clientForChannel(channel);
    if (client == nullptr) {
        return;
    }
    {
        std::lock_guard<std::mutex> lock(client->mutex);
        client->connected = false;
        client->lastError = "OpenD 连接已断开，错误码=" + std::to_string(errorCode);
    }
    client->condition.notify_all();
}

void onReply(
    FTAPIChannelPtr channel,
    FTAPI_ReqReplyType type,
    const FTAPI_ProtoHeader *header,
    const Futu::i8_t *data,
    Futu::i32_t length
) {
    ChangFuFutuClient *client = clientForChannel(channel);
    if (client == nullptr || header == nullptr) {
        return;
    }
    ChangFuFutuReply reply;
    reply.type = static_cast<int>(type);
    if (data != nullptr && length > 0) {
        reply.data.assign(data, data + length);
    }
    {
        std::lock_guard<std::mutex> lock(client->mutex);
        client->replies[header->nSerialNo] = std::move(reply);
    }
    client->condition.notify_all();
}

void setError(ChangFuFutuClient *client, const std::string &message) {
    std::lock_guard<std::mutex> lock(client->mutex);
    client->lastError = message;
}

ChangFuFutuStatus sendRequest(
    ChangFuFutuClient *client,
    unsigned int protocol,
    const google::protobuf::Message &request,
    google::protobuf::Message *response
) {
    std::string body;
    if (!request.SerializeToString(&body)) {
        setError(client, "Futu 请求编码失败");
        return ChangFuFutuStatusOperationFailed;
    }

    const unsigned int serial = FTAPIChannel_SendProto(
        client->channel,
        protocol,
        0,
        reinterpret_cast<const Futu::i8_t *>(body.data()),
        static_cast<Futu::i32_t>(body.size())
    );
    if (serial == 0) {
        setError(client, "Futu 请求发送失败");
        return ChangFuFutuStatusOperationFailed;
    }

    ChangFuFutuReply reply;
    {
        std::unique_lock<std::mutex> lock(client->mutex);
        const bool received = client->condition.wait_for(
            lock,
            std::chrono::seconds(12),
            [client, serial] {
                return client->replies.count(serial) > 0 || !client->connected;
            }
        );
        if (!received) {
            client->lastError = "Futu 请求等待超时";
            return ChangFuFutuStatusTimeout;
        }
        const auto iterator = client->replies.find(serial);
        if (iterator == client->replies.end()) {
            if (client->lastError.empty()) {
                client->lastError = "OpenD 已断开";
            }
            return ChangFuFutuStatusConnectionFailed;
        }
        reply = std::move(iterator->second);
        client->replies.erase(iterator);
    }

    if (reply.type != FTAPI_ReqReplyType_SvrReply) {
        setError(client, reply.type == FTAPI_ReqReplyType_Timeout
            ? "OpenD 返回请求超时"
            : "OpenD 在请求期间断开");
        return reply.type == FTAPI_ReqReplyType_Timeout
            ? ChangFuFutuStatusTimeout
            : ChangFuFutuStatusConnectionFailed;
    }
    if (!response->ParseFromArray(reply.data.data(), static_cast<int>(reply.data.size()))) {
        setError(client, "Futu 响应解析失败");
        return ChangFuFutuStatusOperationFailed;
    }
    return ChangFuFutuStatusOk;
}

std::string currencyCode(int currency) {
    switch (currency) {
    case Trd_Common::Currency_HKD: return "HKD";
    case Trd_Common::Currency_USD: return "USD";
    case Trd_Common::Currency_CNH: return "CNH";
    case Trd_Common::Currency_JPY: return "JPY";
    case Trd_Common::Currency_SGD: return "SGD";
    case Trd_Common::Currency_AUD: return "AUD";
    case Trd_Common::Currency_CAD: return "CAD";
    case Trd_Common::Currency_MYR: return "MYR";
    case Trd_Common::Currency_NZD: return "NZD";
    default: return "HKD";
    }
}

int currencyForMarket(int market) {
    switch (market) {
    case Trd_Common::TrdMarket_US: return Trd_Common::Currency_USD;
    case Trd_Common::TrdMarket_CN:
    case Trd_Common::TrdMarket_HKCC: return Trd_Common::Currency_CNH;
    case Trd_Common::TrdMarket_SG: return Trd_Common::Currency_SGD;
    case Trd_Common::TrdMarket_JP: return Trd_Common::Currency_JPY;
    case Trd_Common::TrdMarket_AU: return Trd_Common::Currency_AUD;
    case Trd_Common::TrdMarket_CA: return Trd_Common::Currency_CAD;
    case Trd_Common::TrdMarket_MY: return Trd_Common::Currency_MYR;
    default: return Trd_Common::Currency_HKD;
    }
}

int preferredMarket(const std::vector<int> &markets) {
    const int priority[] = {
        Trd_Common::TrdMarket_US,
        Trd_Common::TrdMarket_HK,
        Trd_Common::TrdMarket_CN,
        Trd_Common::TrdMarket_SG,
        Trd_Common::TrdMarket_JP,
        Trd_Common::TrdMarket_AU,
        Trd_Common::TrdMarket_CA,
        Trd_Common::TrdMarket_MY
    };
    for (int candidate : priority) {
        if (std::find(markets.begin(), markets.end(), candidate) != markets.end()) {
            return candidate;
        }
    }
    return markets.empty() ? Trd_Common::TrdMarket_HK : markets.front();
}

std::string marketPrefix(const Trd_Common::Position &position, int fallbackMarket) {
    const int market = position.has_trdmarket() ? position.trdmarket() : fallbackMarket;
    switch (market) {
    case Trd_Common::TrdMarket_US: return "US";
    case Trd_Common::TrdMarket_HK: return "HK";
    case Trd_Common::TrdMarket_CN:
    case Trd_Common::TrdMarket_HKCC: return "CN";
    case Trd_Common::TrdMarket_SG: return "SG";
    case Trd_Common::TrdMarket_JP: return "JP";
    case Trd_Common::TrdMarket_AU: return "AU";
    case Trd_Common::TrdMarket_CA: return "CA";
    case Trd_Common::TrdMarket_MY: return "MY";
    default: return "";
    }
}

bool representativeSecurity(
    int market,
    int *quoteMarket,
    std::string *code,
    std::string *marketName
) {
    switch (market) {
    case Trd_Common::TrdMarket_US:
        *quoteMarket = Qot_Common::QotMarket_US_Security;
        *code = "AAPL";
        *marketName = "美股";
        return true;
    case Trd_Common::TrdMarket_HK:
        *quoteMarket = Qot_Common::QotMarket_HK_Security;
        *code = "00700";
        *marketName = "港股";
        return true;
    case Trd_Common::TrdMarket_CN:
    case Trd_Common::TrdMarket_HKCC:
        *quoteMarket = Qot_Common::QotMarket_CNSH_Security;
        *code = "600519";
        *marketName = "A 股";
        return true;
    case Trd_Common::TrdMarket_SG:
        *quoteMarket = Qot_Common::QotMarket_SG_Security;
        *code = "D05";
        *marketName = "新加坡";
        return true;
    case Trd_Common::TrdMarket_JP:
        *quoteMarket = Qot_Common::QotMarket_JP_Security;
        *code = "7203";
        *marketName = "日本";
        return true;
    default:
        return false;
    }
}

bool representativeSecurityForQuoteMarket(
    int quoteMarket,
    Qot_Common::Security *security
) {
    security->set_market(quoteMarket);
    switch (quoteMarket) {
    case Qot_Common::QotMarket_US_Security:
        security->set_code("AAPL");
        return true;
    case Qot_Common::QotMarket_HK_Security:
        security->set_code("00700");
        return true;
    case Qot_Common::QotMarket_CNSH_Security:
        security->set_code("600519");
        return true;
    case Qot_Common::QotMarket_CNSZ_Security:
        security->set_code("000001");
        return true;
    case Qot_Common::QotMarket_SG_Security:
        security->set_code("D05");
        return true;
    case Qot_Common::QotMarket_JP_Security:
        security->set_code("7203");
        return true;
    default:
        return false;
    }
}

std::string marketStateLabel(int state) {
    switch (state) {
    case Qot_Common::QotMarketState_Auction: return "竞价";
    case Qot_Common::QotMarketState_WaitingOpen: return "等待开盘";
    case Qot_Common::QotMarketState_Morning:
    case Qot_Common::QotMarketState_Afternoon:
    case Qot_Common::QotMarketState_FutureDayOpen:
    case Qot_Common::QotMarketState_FutureOpen:
    case Qot_Common::QotMarketState_FutureBreakOver:
        return "交易中";
    case Qot_Common::QotMarketState_NightOpen:
    case Qot_Common::QotMarketState_NIGHT:
    case Qot_Common::QotMarketState_OVERNIGHT_BEGIN:
    case Qot_Common::QotMarketState_OVERNIGHT:
        return "夜盘";
    case Qot_Common::QotMarketState_NightEnd:
    case Qot_Common::QotMarketState_OVERNIGHT_END:
        return "夜盘结束";
    case Qot_Common::QotMarketState_Rest:
    case Qot_Common::QotMarketState_FutureDayBreak:
    case Qot_Common::QotMarketState_FutureBreak:
        return "休市";
    case Qot_Common::QotMarketState_PreMarketBegin: return "盘前";
    case Qot_Common::QotMarketState_PreMarketEnd: return "等待开盘";
    case Qot_Common::QotMarketState_AfterHoursBegin: return "盘后";
    case Qot_Common::QotMarketState_AfterHoursEnd: return "已收盘";
    case Qot_Common::QotMarketState_HkCas:
    case Qot_Common::QotMarketState_CLOSE_AUCTION:
        return "收市竞价";
    case Qot_Common::QotMarketState_Closed:
    case Qot_Common::QotMarketState_AFTERNOON_END:
        return "已收盘";
    default: return "非交易时段";
    }
}

ChangFuFutuStatus loadAccounts(
    ChangFuFutuClient *client,
    std::vector<ChangFuFutuAccount> *accounts
) {
    Trd_GetAccList::Request request;
    request.mutable_c2s()->set_userid(0);
    request.mutable_c2s()->set_trdcategory(Trd_Common::TrdCategory_Security);
    request.mutable_c2s()->set_needgeneralsecaccount(true);
    Trd_GetAccList::Response response;
    ChangFuFutuStatus status = sendRequest(
        client,
        FTAPI_ProtoID_Trd_GetAccList,
        request,
        &response
    );
    if (status != ChangFuFutuStatusOk) {
        return status;
    }
    if (response.rettype() != Common::RetType_Succeed || !response.has_s2c()) {
        setError(client, response.has_retmsg() ? response.retmsg() : "获取 Futu 账户失败");
        return ChangFuFutuStatusOperationFailed;
    }
    for (const auto &item : response.s2c().acclist()) {
        ChangFuFutuAccount account;
        account.id = item.accid();
        account.environment = item.trdenv();
        account.accountType = item.has_acctype()
            ? item.acctype()
            : Trd_Common::TrdAccType_Unknown;
        account.accountStatus = item.has_accstatus()
            ? item.accstatus()
            : Trd_Common::TrdAccStatus_Active;
        account.markets.assign(
            item.trdmarketauthlist().begin(),
            item.trdmarketauthlist().end()
        );
        accounts->push_back(std::move(account));
    }
    if (accounts->empty()) {
        setError(client, "OpenD 未返回可用证券账户");
        return ChangFuFutuStatusOperationFailed;
    }
    std::stable_sort(
        accounts->begin(),
        accounts->end(),
        [](const ChangFuFutuAccount &left, const ChangFuFutuAccount &right) {
            return left.environment == Trd_Common::TrdEnv_Real
                && right.environment != Trd_Common::TrdEnv_Real;
        }
    );
    return ChangFuFutuStatusOk;
}

ChangFuFutuStatus loadFunds(
    ChangFuFutuClient *client,
    const ChangFuFutuAccount &account,
    int market,
    int currency,
    bool refreshCache,
    Trd_Common::Funds *funds
) {
    for (bool includeCurrency : {true, false}) {
        Trd_GetFunds::Request request;
        auto *c2s = request.mutable_c2s();
        auto *header = c2s->mutable_header();
        header->set_trdenv(account.environment);
        header->set_accid(account.id);
        header->set_trdmarket(market);
        c2s->set_refreshcache(refreshCache);
        if (includeCurrency) {
            c2s->set_currency(currency);
        }
        Trd_GetFunds::Response response;
        ChangFuFutuStatus status = sendRequest(
            client,
            FTAPI_ProtoID_Trd_GetFunds,
            request,
            &response
        );
        if (status != ChangFuFutuStatusOk) {
            return status;
        }
        if (response.rettype() == Common::RetType_Succeed
            && response.has_s2c()
            && response.s2c().has_funds()) {
            funds->CopyFrom(response.s2c().funds());
            return ChangFuFutuStatusOk;
        }
        setError(client, response.has_retmsg() ? response.retmsg() : "获取 Futu 资金失败");
    }
    return ChangFuFutuStatusOperationFailed;
}

ChangFuFutuStatus loadPositions(
    ChangFuFutuClient *client,
    const ChangFuFutuAccount &account,
    bool refreshCache,
    std::vector<std::pair<int, Trd_Common::Position>> *positions
) {
    std::set<std::string> seen;
    bool requestSucceeded = false;
    std::vector<int> markets = account.markets;
    if (markets.empty()) {
        markets.push_back(Trd_Common::TrdMarket_HK);
    }
    for (int market : markets) {
        Trd_GetPositionList::Request request;
        auto *c2s = request.mutable_c2s();
        auto *header = c2s->mutable_header();
        header->set_trdenv(account.environment);
        header->set_accid(account.id);
        header->set_trdmarket(market);
        c2s->set_refreshcache(refreshCache);
        Trd_GetPositionList::Response response;
        ChangFuFutuStatus status = sendRequest(
            client,
            FTAPI_ProtoID_Trd_GetPositionList,
            request,
            &response
        );
        if (status != ChangFuFutuStatusOk) {
            continue;
        }
        if (response.rettype() != Common::RetType_Succeed || !response.has_s2c()) {
            setError(client, response.has_retmsg() ? response.retmsg() : "获取 Futu 持仓失败");
            continue;
        }
        requestSucceeded = true;
        for (const auto &position : response.s2c().positionlist()) {
            const std::string identity = position.positionid() == 0
                ? std::to_string(market) + ":" + position.code()
                : std::to_string(position.positionid());
            if (seen.insert(identity).second) {
                positions->push_back({market, position});
            }
        }
    }
    if (!requestSucceeded) {
        if (client->lastError.empty()) {
            setError(client, "所有 Futu 持仓请求均失败");
        }
        return ChangFuFutuStatusOperationFailed;
    }
    return ChangFuFutuStatusOk;
}

void loadMarketState(
    ChangFuFutuClient *client,
    int market,
    std::string *marketName,
    std::string *stateLabel,
    int *stateValue
) {
    int quoteMarket = 0;
    std::string code;
    if (!representativeSecurity(market, &quoteMarket, &code, marketName)) {
        *marketName = "市场";
        *stateLabel = "不可用";
        *stateValue = 0;
        return;
    }
    Qot_GetMarketState::Request request;
    auto *security = request.mutable_c2s()->add_securitylist();
    security->set_market(quoteMarket);
    security->set_code(code);
    Qot_GetMarketState::Response response;
    const ChangFuFutuStatus status = sendRequest(
        client,
        FTAPI_ProtoID_Qot_GetMarketState,
        request,
        &response
    );
    if (status != ChangFuFutuStatusOk
        || response.rettype() != Common::RetType_Succeed
        || !response.has_s2c()
        || response.s2c().marketinfolist_size() == 0) {
        *stateLabel = "不可用";
        *stateValue = 0;
        return;
    }
    const auto &marketInfo = response.s2c().marketinfolist(0);
    *stateValue = marketInfo.marketstate();
    *stateLabel = marketStateLabel(*stateValue);
}

void setString(google::protobuf::Struct *object, const char *key, const std::string &value) {
    (*object->mutable_fields())[key].set_string_value(value);
}

void setNumber(google::protobuf::Struct *object, const char *key, double value) {
    (*object->mutable_fields())[key].set_number_value(value);
}

void setBool(google::protobuf::Struct *object, const char *key, bool value) {
    (*object->mutable_fields())[key].set_bool_value(value);
}

ChangFuFutuStatus writeJson(
    ChangFuFutuClient *client,
    const google::protobuf::Struct &root,
    const char *operation,
    char **json
) {
    std::string output;
    google::protobuf::util::JsonPrintOptions options;
    options.add_whitespace = false;
    const auto status =
        google::protobuf::util::MessageToJsonString(root, &output, options);
    if (!status.ok()) {
        setError(client, std::string("Futu ") + operation + " JSON 编码失败");
        return ChangFuFutuStatusOperationFailed;
    }
    char *buffer = static_cast<char *>(std::malloc(output.size() + 1));
    if (buffer == nullptr) {
        setError(client, std::string("Futu ") + operation + "内存分配失败");
        return ChangFuFutuStatusOperationFailed;
    }
    std::memcpy(buffer, output.c_str(), output.size() + 1);
    *json = buffer;
    setError(client, "");
    return ChangFuFutuStatusOk;
}

std::string utcNow() {
    std::time_t now = std::time(nullptr);
    std::tm value{};
    gmtime_r(&now, &value);
    char output[32];
    std::strftime(output, sizeof(output), "%Y-%m-%dT%H:%M:%SZ", &value);
    return output;
}

std::string utcFromEpoch(std::time_t timestamp) {
    std::tm value{};
    gmtime_r(&timestamp, &value);
    char output[32];
    std::strftime(output, sizeof(output), "%Y-%m-%dT%H:%M:%SZ", &value);
    return output;
}

std::string utcAfter(std::time_t timestamp, int seconds) {
    return utcFromEpoch(timestamp + seconds);
}

std::string calendarDate(std::time_t timestamp) {
    std::tm value{};
    gmtime_r(&timestamp, &value);
    char output[16];
    std::strftime(output, sizeof(output), "%Y-%m-%d", &value);
    return output;
}

std::string stableEventId(const std::string &value) {
    unsigned long long hash = 1469598103934665603ULL;
    for (unsigned char character : value) {
        hash ^= character;
        hash *= 1099511628211ULL;
    }
    std::ostringstream output;
    output << "FUTU-" << std::hex << std::setfill('0') << std::setw(16) << hash;
    return output.str();
}

std::vector<std::string> splitCsv(const std::string &csv, std::size_t limit) {
    std::vector<std::string> values;
    std::set<std::string> seen;
    std::stringstream stream(csv);
    std::string item;
    while (std::getline(stream, item, ',') && values.size() < limit) {
        if (!item.empty() && seen.insert(item).second) {
            values.push_back(item);
        }
    }
    return values;
}

void appendStringList(
    google::protobuf::Struct *object,
    const char *key,
    const std::vector<std::string> &values
) {
    auto *list = (*object->mutable_fields())[key].mutable_list_value();
    for (const auto &value : values) {
        list->add_values()->set_string_value(value);
    }
}

google::protobuf::Struct *appendMarketEvent(
    google::protobuf::ListValue *events,
    const std::string &group,
    const std::string &category,
    const std::string &title,
    const std::string &source,
    const std::string &publishedAt,
    const std::string &fetchedAt,
    const std::vector<std::string> &relatedSymbols,
    const std::string &importance,
    const std::string &validUntil,
    const std::string &url = ""
) {
    auto *event = events->add_values()->mutable_struct_value();
    setString(event, "id", stableEventId(
        group + "|" + category + "|" + title + "|" + publishedAt + "|" + url
    ));
    setString(event, "group", group);
    setString(event, "category", category);
    setString(event, "title", title);
    setString(event, "source", source.empty() ? "Futu OpenD" : source);
    setString(event, "publishedAt", publishedAt);
    setString(event, "fetchedAt", fetchedAt);
    appendStringList(event, "relatedSymbols", relatedSymbols);
    setString(event, "importance", importance);
    setString(event, "validUntil", validUntil);
    if (!url.empty()) {
        setString(event, "url", url);
    }
    return event;
}

std::string uppercaseAscii(std::string value) {
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) {
        return static_cast<char>(std::toupper(character));
    });
    return value;
}

bool isTechnologyMacroEvent(const std::string &title) {
    const std::string value = uppercaseAscii(title);
    const char *terms[] = {
        "FOMC", "FEDERAL FUNDS", "FED INTEREST RATE", "POWELL",
        "CORE CPI", "CPI", "CORE PCE", "PCE", "CONSUMER PRICE",
        "NONFARM", "UNEMPLOYMENT RATE", "JOBLESS CLAIMS",
        "GDP", "ISM", "PMI", "PURCHASING MANAGERS",
        "10-YEAR TREASURY", "10 YEAR TREASURY",
        "2-YEAR TREASURY", "2 YEAR TREASURY",
        "TREASURY YIELD", "DOLLAR INDEX"
    };
    for (const char *term : terms) {
        if (value.find(term) != std::string::npos) {
            return true;
        }
    }
    return title.find("美联储") != std::string::npos
        || title.find("联邦基金") != std::string::npos
        || title.find("通胀") != std::string::npos
        || title.find("非农") != std::string::npos
        || title.find("失业率") != std::string::npos
        || title.find("初请失业金") != std::string::npos
        || title.find("国内生产总值") != std::string::npos
        || title.find("采购经理") != std::string::npos
        || title.find("美债收益率") != std::string::npos
        || title.find("美元指数") != std::string::npos;
}

bool csvContains(const std::string &csv, const std::string &value) {
    if (csv.empty()) {
        return true;
    }
    std::stringstream stream(csv);
    std::string item;
    while (std::getline(stream, item, ',')) {
        if (uppercaseAscii(item) == value) {
            return true;
        }
    }
    return false;
}

bool brokerMarket(
    int quoteMarket,
    std::string *market,
    std::string *currency
) {
    switch (quoteMarket) {
    case Qot_Common::QotMarket_US_Security:
        *market = "US";
        *currency = "USD";
        return true;
    case Qot_Common::QotMarket_HK_Security:
        *market = "HK";
        *currency = "HKD";
        return true;
    case Qot_Common::QotMarket_CNSH_Security:
    case Qot_Common::QotMarket_CNSZ_Security:
        *market = "CN";
        *currency = "CNY";
        return true;
    case Qot_Common::QotMarket_SG_Security:
        *market = "SG";
        *currency = "SGD";
        return true;
    default:
        return false;
    }
}

bool parseProviderSymbol(
    const std::string &rawSymbol,
    Qot_Common::Security *security,
    std::string *canonicalSymbol
) {
    const std::string symbol = uppercaseAscii(rawSymbol);
    const std::size_t separator = symbol.find('.');
    if (separator == std::string::npos) {
        return false;
    }
    std::string market = symbol.substr(0, separator);
    std::string code = symbol.substr(separator + 1);
    if (market != "US" && market != "HK" && market != "CN" && market != "SG") {
        std::swap(market, code);
    }
    if (market == "US") {
        security->set_market(Qot_Common::QotMarket_US_Security);
    } else if (market == "HK") {
        security->set_market(Qot_Common::QotMarket_HK_Security);
    } else if (market == "CN") {
        security->set_market(
            !code.empty() && (code[0] == '5' || code[0] == '6' || code[0] == '9')
                ? Qot_Common::QotMarket_CNSH_Security
                : Qot_Common::QotMarket_CNSZ_Security
        );
    } else if (market == "SG") {
        security->set_market(Qot_Common::QotMarket_SG_Security);
    } else {
        return false;
    }
    if (code.empty()) {
        return false;
    }
    security->set_code(code);
    *canonicalSymbol = market + "." + code;
    return true;
}

std::string decimalString(double value) {
    std::ostringstream stream;
    stream << std::setprecision(15) << value;
    return stream.str();
}

bool isRecognizableETF(const std::string &name) {
    const std::string uppercaseName = uppercaseAscii(name);
    return uppercaseName.find("ETF") != std::string::npos
        || name.find("交易型开放式") != std::string::npos;
}

bool exactSearchSecurity(
    const std::string &query,
    const std::string &marketFilter,
    std::vector<Qot_Common::Security> *securities
) {
    const std::string normalized = uppercaseAscii(query);
    if (normalized.empty()
        || !std::all_of(normalized.begin(), normalized.end(), [](unsigned char character) {
            return std::isalnum(character) || character == '.' || character == '-';
        })) {
        return false;
    }

    std::string explicitMarket;
    std::string code = normalized;
    const std::size_t separator = normalized.find('.');
    if (separator != std::string::npos) {
        if (normalized.find('.', separator + 1) != std::string::npos) {
            return false;
        }
        explicitMarket = normalized.substr(0, separator);
        code = normalized.substr(separator + 1);
    }
    if (code.empty()) {
        return false;
    }

    const auto append = [&](const std::string &market) {
        Qot_Common::Security security;
        if (market == "US") {
            security.set_market(Qot_Common::QotMarket_US_Security);
        } else if (market == "HK") {
            security.set_market(Qot_Common::QotMarket_HK_Security);
        } else if (market == "CN") {
            security.set_market(
                code[0] == '5' || code[0] == '6' || code[0] == '9'
                    ? Qot_Common::QotMarket_CNSH_Security
                    : Qot_Common::QotMarket_CNSZ_Security
            );
        } else if (market == "SG") {
            security.set_market(Qot_Common::QotMarket_SG_Security);
        } else {
            return;
        }
        security.set_code(code);
        securities->push_back(std::move(security));
    };

    if (!explicitMarket.empty()) {
        if (csvContains(marketFilter, explicitMarket)) {
            append(explicitMarket);
        }
        return !securities->empty();
    }
    std::stringstream markets(marketFilter);
    std::string market;
    while (std::getline(markets, market, ',')) {
        append(uppercaseAscii(market));
    }
    return !securities->empty();
}

std::string quotePrefix(int market);

struct FuzzySecurityCandidate {
    std::string providerSymbol;
    std::string displayName;
    std::string market;
    std::string currency;
    std::string instrumentType;
    std::string unavailableReason;
    bool addable = false;
    int score = 0;
};

std::vector<int> quoteMarkets(const std::string &marketFilter) {
    std::vector<int> markets;
    if (csvContains(marketFilter, "US")) {
        markets.push_back(Qot_Common::QotMarket_US_Security);
    }
    if (csvContains(marketFilter, "HK")) {
        markets.push_back(Qot_Common::QotMarket_HK_Security);
    }
    if (csvContains(marketFilter, "CN")) {
        markets.push_back(Qot_Common::QotMarket_CNSH_Security);
        markets.push_back(Qot_Common::QotMarket_CNSZ_Security);
    }
    if (csvContains(marketFilter, "SG")) {
        markets.push_back(Qot_Common::QotMarket_SG_Security);
    }
    return markets;
}

int fuzzyMatchScore(
    const std::string &query,
    const std::string &code,
    const std::string &name
) {
    const std::string normalizedQuery = uppercaseAscii(query);
    const std::string normalizedCode = uppercaseAscii(code);
    const std::string normalizedName = uppercaseAscii(name);
    if (normalizedCode == normalizedQuery) {
        return 0;
    }
    if (normalizedCode.rfind(normalizedQuery, 0) == 0) {
        return 1;
    }
    if (normalizedName.rfind(normalizedQuery, 0) == 0) {
        return 2;
    }
    if (normalizedCode.find(normalizedQuery) != std::string::npos) {
        return 3;
    }
    if (normalizedName.find(normalizedQuery) != std::string::npos) {
        return 4;
    }
    return -1;
}

bool loadStaticSearchCandidates(
    ChangFuFutuClient *client,
    const std::string &query,
    const std::string &marketFilter,
    const std::string &typeFilter,
    std::vector<FuzzySecurityCandidate> *candidates
) {
    bool requestSucceeded = false;
    std::set<std::string> seen;
    for (int marketValue : quoteMarkets(marketFilter)) {
        for (const auto &type : {
            std::pair<int, std::string>(Qot_Common::SecurityType_Eqty, "STOCK"),
            std::pair<int, std::string>(Qot_Common::SecurityType_Trust, "ETF")
        }) {
            if (!csvContains(typeFilter, type.second)) {
                continue;
            }
            Qot_GetStaticInfo::Request request;
            request.mutable_c2s()->set_market(marketValue);
            request.mutable_c2s()->set_sectype(type.first);
            Qot_GetStaticInfo::Response response;
            const ChangFuFutuStatus status = sendRequest(
                client,
                FTAPI_ProtoID_Qot_GetStaticInfo,
                request,
                &response
            );
            if (status != ChangFuFutuStatusOk
                || response.rettype() != Common::RetType_Succeed
                || !response.has_s2c()) {
                continue;
            }
            requestSucceeded = true;
            for (const auto &info : response.s2c().staticinfolist()) {
                if (!info.has_basic()) {
                    continue;
                }
                const auto &basic = info.basic();
                std::string market;
                std::string currency;
                if (!brokerMarket(basic.security().market(), &market, &currency)) {
                    continue;
                }
                const int score = fuzzyMatchScore(
                    query,
                    basic.security().code(),
                    basic.name()
                );
                if (score < 0) {
                    continue;
                }
                const std::string symbol =
                    quotePrefix(basic.security().market()) + "." + basic.security().code();
                if (!seen.insert(symbol).second) {
                    continue;
                }
                bool addable = !basic.delisting();
                std::string unavailableReason =
                    addable ? "" : "该标的已退市，不能加入标的池";
                if (type.second == "ETF" && !isRecognizableETF(basic.name())) {
                    addable = false;
                    unavailableReason = "Futu 将该标的归为 Trust，无法确认是否为 ETF";
                }
                candidates->push_back({
                    symbol,
                    basic.name().empty() ? basic.security().code() : basic.name(),
                    market,
                    currency,
                    type.second,
                    unavailableReason,
                    addable,
                    score
                });
            }
        }
    }
    std::sort(
        candidates->begin(),
        candidates->end(),
        [](const FuzzySecurityCandidate &left, const FuzzySecurityCandidate &right) {
            if (left.score != right.score) {
                return left.score < right.score;
            }
            return left.providerSymbol < right.providerSymbol;
        }
    );
    return requestSucceeded;
}

void appendGap(google::protobuf::ListValue *gaps, const std::string &message) {
    gaps->add_values()->set_string_value(message);
}

std::string quotePrefix(int market) {
    switch (market) {
    case Qot_Common::QotMarket_HK_Security: return "HK";
    case Qot_Common::QotMarket_US_Security: return "US";
    case Qot_Common::QotMarket_CNSH_Security:
    case Qot_Common::QotMarket_CNSZ_Security: return "CN";
    case Qot_Common::QotMarket_SG_Security: return "SG";
    case Qot_Common::QotMarket_JP_Security: return "JP";
    case Qot_Common::QotMarket_AU_Security: return "AU";
    case Qot_Common::QotMarket_MY_Security: return "MY";
    case Qot_Common::QotMarket_CA_Security: return "CA";
    default: return "";
    }
}

std::string quoteSymbol(const Qot_Common::Security &security) {
    const std::string prefix = quotePrefix(security.market());
    return prefix.empty() ? security.code() : prefix + "." + security.code();
}

bool quoteSecurityForPosition(
    const std::pair<int, Trd_Common::Position> &entry,
    Qot_Common::Security *security
) {
    const auto &position = entry.second;
    int quoteMarket = Qot_Common::QotMarket_Unknown;
    if (position.has_secmarket()) {
        switch (position.secmarket()) {
        case Trd_Common::TrdSecMarket_HK:
            quoteMarket = Qot_Common::QotMarket_HK_Security;
            break;
        case Trd_Common::TrdSecMarket_US:
            quoteMarket = Qot_Common::QotMarket_US_Security;
            break;
        case Trd_Common::TrdSecMarket_CN_SH:
            quoteMarket = Qot_Common::QotMarket_CNSH_Security;
            break;
        case Trd_Common::TrdSecMarket_CN_SZ:
            quoteMarket = Qot_Common::QotMarket_CNSZ_Security;
            break;
        case Trd_Common::TrdSecMarket_SG:
            quoteMarket = Qot_Common::QotMarket_SG_Security;
            break;
        case Trd_Common::TrdSecMarket_JP:
            quoteMarket = Qot_Common::QotMarket_JP_Security;
            break;
        case Trd_Common::TrdSecMarket_AU:
            quoteMarket = Qot_Common::QotMarket_AU_Security;
            break;
        case Trd_Common::TrdSecMarket_MY:
            quoteMarket = Qot_Common::QotMarket_MY_Security;
            break;
        case Trd_Common::TrdSecMarket_CA:
            quoteMarket = Qot_Common::QotMarket_CA_Security;
            break;
        default:
            break;
        }
    }
    if (quoteMarket == Qot_Common::QotMarket_Unknown) {
        switch (entry.first) {
        case Trd_Common::TrdMarket_HK:
            quoteMarket = Qot_Common::QotMarket_HK_Security;
            break;
        case Trd_Common::TrdMarket_US:
            quoteMarket = Qot_Common::QotMarket_US_Security;
            break;
        case Trd_Common::TrdMarket_CN:
        case Trd_Common::TrdMarket_HKCC:
            quoteMarket = !position.code().empty()
                && (position.code()[0] == '5'
                    || position.code()[0] == '6'
                    || position.code()[0] == '9')
                ? Qot_Common::QotMarket_CNSH_Security
                : Qot_Common::QotMarket_CNSZ_Security;
            break;
        case Trd_Common::TrdMarket_SG:
            quoteMarket = Qot_Common::QotMarket_SG_Security;
            break;
        case Trd_Common::TrdMarket_JP:
            quoteMarket = Qot_Common::QotMarket_JP_Security;
            break;
        default:
            return false;
        }
    }
    security->set_market(quoteMarket);
    security->set_code(position.code());
    return true;
}

bool quoteSecurityForSymbol(
    const std::string &symbol,
    Qot_Common::Security *security
) {
    const std::size_t separator = symbol.find('.');
    if (separator == std::string::npos || separator == 0
        || separator + 1 >= symbol.size()) {
        return false;
    }
    std::string market = symbol.substr(0, separator);
    std::transform(market.begin(), market.end(), market.begin(), [](unsigned char value) {
        return static_cast<char>(std::toupper(value));
    });
    const std::string code = symbol.substr(separator + 1);
    if (market == "US") {
        security->set_market(Qot_Common::QotMarket_US_Security);
    } else if (market == "HK") {
        security->set_market(Qot_Common::QotMarket_HK_Security);
    } else if (market == "SG") {
        security->set_market(Qot_Common::QotMarket_SG_Security);
    } else if (market == "CN") {
        security->set_market(
            code[0] == '5' || code[0] == '6' || code[0] == '9'
                ? Qot_Common::QotMarket_CNSH_Security
                : Qot_Common::QotMarket_CNSZ_Security
        );
    } else {
        return false;
    }
    security->set_code(code);
    return true;
}

void loadQuoteSnapshot(
    ChangFuFutuClient *client,
    const std::vector<std::pair<int, Trd_Common::Position>> &positions,
    const std::string &additionalSymbols,
    google::protobuf::Struct *root,
    google::protobuf::ListValue *gaps
) {
    std::vector<Qot_Common::Security> securities;
    std::set<std::string> seen;
    std::stringstream symbolStream(additionalSymbols);
    std::string symbol;
    while (securities.size() < 100 && std::getline(symbolStream, symbol, ',')) {
        Qot_Common::Security security;
        if (quoteSecurityForSymbol(symbol, &security)
            && seen.insert(quoteSymbol(security)).second) {
            securities.push_back(security);
        }
    }
    for (const auto &entry : positions) {
        Qot_Common::Security security;
        if (quoteSecurityForPosition(entry, &security)
            && seen.insert(quoteSymbol(security)).second) {
            securities.push_back(security);
        }
    }
    if (securities.empty()) {
        appendGap(gaps, "没有可用于行情订阅的持仓标的");
        return;
    }

    Qot_Sub::Request subscriptionRequest;
    auto *subscription = subscriptionRequest.mutable_c2s();
    for (const auto &security : securities) {
        subscription->add_securitylist()->CopyFrom(security);
    }
    subscription->add_subtypelist(Qot_Common::SubType_Basic);
    subscription->add_subtypelist(Qot_Common::SubType_KL_1Min);
    subscription->add_subtypelist(Qot_Common::SubType_Ticker);
    subscription->add_subtypelist(Qot_Common::SubType_OrderBook);
    subscription->set_issuborunsub(true);
    subscription->set_isregorunregpush(false);
    subscription->set_issuborderbookdetail(false);
    Qot_Sub::Response subscriptionResponse;
    ChangFuFutuStatus status = sendRequest(
        client,
        FTAPI_ProtoID_Qot_Sub,
        subscriptionRequest,
        &subscriptionResponse
    );
    if (status != ChangFuFutuStatusOk
        || subscriptionResponse.rettype() != Common::RetType_Succeed) {
        appendGap(gaps, "行情订阅失败，可能缺少行情权限或订阅额度");
    }

    struct ExtendedSessionPrices {
        bool hasPreMarket = false;
        double preMarket = 0;
        bool hasAfterHours = false;
        double afterHours = 0;
        bool hasOvernight = false;
        double overnight = 0;
    };
    std::unordered_map<std::string, ExtendedSessionPrices> extendedPrices;

    Qot_GetSecuritySnapshot::Request snapshotRequest;
    for (const auto &security : securities) {
        snapshotRequest.mutable_c2s()->add_securitylist()->CopyFrom(security);
    }
    Qot_GetSecuritySnapshot::Response snapshotResponse;
    status = sendRequest(
        client,
        FTAPI_ProtoID_Qot_GetSecuritySnapshot,
        snapshotRequest,
        &snapshotResponse
    );
    if (status == ChangFuFutuStatusOk
        && snapshotResponse.rettype() == Common::RetType_Succeed
        && snapshotResponse.has_s2c()) {
        for (const auto &snapshot : snapshotResponse.s2c().snapshotlist()) {
            if (!snapshot.has_basic()) {
                continue;
            }
            const auto &basic = snapshot.basic();
            ExtendedSessionPrices prices;
            if (basic.has_premarket() && basic.premarket().has_price()) {
                prices.hasPreMarket = true;
                prices.preMarket = basic.premarket().price();
            }
            if (basic.has_aftermarket() && basic.aftermarket().has_price()) {
                prices.hasAfterHours = true;
                prices.afterHours = basic.aftermarket().price();
            }
            if (basic.has_overnight() && basic.overnight().has_price()) {
                prices.hasOvernight = true;
                prices.overnight = basic.overnight().price();
            }
            extendedPrices[quoteSymbol(basic.security())] = prices;
        }
    } else {
        appendGap(gaps, "扩展时段行情不可用，盘前、盘后或夜盘价格可能缺失");
    }

    std::map<int, Qot_Common::Security> marketRepresentatives;
    for (const auto &security : securities) {
        if (marketRepresentatives.find(security.market()) != marketRepresentatives.end()) {
            continue;
        }
        Qot_Common::Security representative;
        if (representativeSecurityForQuoteMarket(security.market(), &representative)) {
            marketRepresentatives.emplace(security.market(), representative);
        }
    }
    std::map<int, std::pair<int, std::string>> marketStates;
    for (const auto &entry : marketRepresentatives) {
        Qot_GetMarketState::Request stateRequest;
        stateRequest.mutable_c2s()->add_securitylist()->CopyFrom(entry.second);
        Qot_GetMarketState::Response stateResponse;
        status = sendRequest(
            client,
            FTAPI_ProtoID_Qot_GetMarketState,
            stateRequest,
            &stateResponse
        );
        if (status == ChangFuFutuStatusOk
            && stateResponse.rettype() == Common::RetType_Succeed
            && stateResponse.has_s2c()
            && stateResponse.s2c().marketinfolist_size() > 0) {
            const int stateValue = stateResponse.s2c().marketinfolist(0).marketstate();
            marketStates[entry.first] = {stateValue, marketStateLabel(stateValue)};
        }
    }
    if (marketStates.size() != marketRepresentatives.size()) {
        appendGap(gaps, "逐市场交易状态不可用，部分持仓时段将显示未知");
    }

    google::protobuf::ListValue *barList =
        (*root->mutable_fields())["minuteBars"].mutable_list_value();
    google::protobuf::ListValue *tickerList =
        (*root->mutable_fields())["tickerPoints"].mutable_list_value();
    google::protobuf::ListValue *bookList =
        (*root->mutable_fields())["orderBooks"].mutable_list_value();
    const std::size_t detailCount = std::min<std::size_t>(securities.size(), 8);
    if (securities.size() > detailCount) {
        appendGap(gaps, "K 线、盘口与逐笔仅加载前 8 个优先标的");
    }
    for (std::size_t index = 0; index < detailCount; ++index) {
        const auto &security = securities[index];
        const std::string symbol = quoteSymbol(security);

        Qot_GetKL::Request barRequest;
        barRequest.mutable_c2s()->mutable_security()->CopyFrom(security);
        barRequest.mutable_c2s()->set_rehabtype(Qot_Common::RehabType_Forward);
        barRequest.mutable_c2s()->set_kltype(Qot_Common::KLType_1Min);
        barRequest.mutable_c2s()->set_reqnum(60);
        Qot_GetKL::Response barResponse;
        status = sendRequest(client, FTAPI_ProtoID_Qot_GetKL, barRequest, &barResponse);
        if (status == ChangFuFutuStatusOk
            && barResponse.rettype() == Common::RetType_Succeed
            && barResponse.has_s2c()) {
            for (const auto &bar : barResponse.s2c().kllist()) {
                auto *object = barList->add_values()->mutable_struct_value();
                setString(object, "symbol", symbol);
                setString(object, "time", bar.time());
                setNumber(object, "open", bar.openprice());
                setNumber(object, "high", bar.highprice());
                setNumber(object, "low", bar.lowprice());
                setNumber(object, "close", bar.closeprice());
                setNumber(object, "volume", static_cast<double>(bar.volume()));
                if (bar.has_turnover()) {
                    setNumber(object, "turnover", bar.turnover());
                }
            }
        } else {
            appendGap(gaps, symbol + " 分钟 K 线不可用");
        }

        Qot_GetTicker::Request tickerRequest;
        tickerRequest.mutable_c2s()->mutable_security()->CopyFrom(security);
        tickerRequest.mutable_c2s()->set_maxretnum(50);
        Qot_GetTicker::Response tickerResponse;
        status = sendRequest(
            client,
            FTAPI_ProtoID_Qot_GetTicker,
            tickerRequest,
            &tickerResponse
        );
        if (status == ChangFuFutuStatusOk
            && tickerResponse.rettype() == Common::RetType_Succeed
            && tickerResponse.has_s2c()) {
            for (const auto &ticker : tickerResponse.s2c().tickerlist()) {
                auto *object = tickerList->add_values()->mutable_struct_value();
                setString(object, "symbol", symbol);
                setString(object, "time", ticker.time());
                setNumber(object, "sequence", static_cast<double>(ticker.sequence()));
                setNumber(object, "price", ticker.price());
                setNumber(object, "volume", static_cast<double>(ticker.volume()));
                setNumber(object, "direction", ticker.dir());
            }
        } else {
            appendGap(gaps, symbol + " 逐笔成交不可用");
        }

        Qot_GetOrderBook::Request bookRequest;
        bookRequest.mutable_c2s()->mutable_security()->CopyFrom(security);
        bookRequest.mutable_c2s()->set_num(10);
        Qot_GetOrderBook::Response bookResponse;
        status = sendRequest(
            client,
            FTAPI_ProtoID_Qot_GetOrderBook,
            bookRequest,
            &bookResponse
        );
        if (status == ChangFuFutuStatusOk
            && bookResponse.rettype() == Common::RetType_Succeed
            && bookResponse.has_s2c()) {
            auto *bookObject = bookList->add_values()->mutable_struct_value();
            setString(bookObject, "symbol", symbol);
            auto appendLevels = [](
                google::protobuf::ListValue *target,
                const auto &levels,
                const char *side
            ) {
                int level = 1;
                for (const auto &source : levels) {
                    auto *object = target->add_values()->mutable_struct_value();
                    setString(object, "side", side);
                    setNumber(object, "level", level++);
                    setNumber(object, "price", source.price());
                    setNumber(object, "volume", static_cast<double>(source.volume()));
                    if (source.has_oredercount()) {
                        setNumber(object, "orderCount", source.oredercount());
                    }
                }
            };
            appendLevels(
                (*bookObject->mutable_fields())["asks"].mutable_list_value(),
                bookResponse.s2c().orderbookasklist(),
                "ASK"
            );
            appendLevels(
                (*bookObject->mutable_fields())["bids"].mutable_list_value(),
                bookResponse.s2c().orderbookbidlist(),
                "BID"
            );
        } else {
            appendGap(gaps, symbol + " 盘口不可用");
        }
    }

    // Read executable quotes last so slow per-symbol depth collection cannot
    // make them stale before the signed context is created.
    Qot_GetBasicQot::Request quoteRequest;
    for (const auto &security : securities) {
        quoteRequest.mutable_c2s()->add_securitylist()->CopyFrom(security);
    }
    Qot_GetBasicQot::Response quoteResponse;
    status = sendRequest(
        client,
        FTAPI_ProtoID_Qot_GetBasicQot,
        quoteRequest,
        &quoteResponse
    );
    google::protobuf::ListValue *quoteList =
        (*root->mutable_fields())["quotes"].mutable_list_value();
    if (status == ChangFuFutuStatusOk
        && quoteResponse.rettype() == Common::RetType_Succeed
        && quoteResponse.has_s2c()) {
        for (const auto &quote : quoteResponse.s2c().basicqotlist()) {
            auto *object = quoteList->add_values()->mutable_struct_value();
            setString(object, "symbol", quoteSymbol(quote.security()));
            setString(object, "name", quote.name());
            setNumber(object, "lastPrice", quote.curprice());
            setNumber(object, "openPrice", quote.openprice());
            setNumber(object, "highPrice", quote.highprice());
            setNumber(object, "lowPrice", quote.lowprice());
            setNumber(object, "previousClose", quote.lastcloseprice());
            setNumber(object, "volume", static_cast<double>(quote.volume()));
            setNumber(object, "turnover", quote.turnover());
            setString(object, "updateTime", quote.updatetime());
            const auto marketState = marketStates.find(quote.security().market());
            if (marketState != marketStates.end()) {
                setNumber(object, "marketStateValue", marketState->second.first);
                setString(object, "marketState", marketState->second.second);
            }
            const auto extended = extendedPrices.find(quoteSymbol(quote.security()));
            if (extended != extendedPrices.end()) {
                if (extended->second.hasPreMarket) {
                    setNumber(object, "preMarketPrice", extended->second.preMarket);
                }
                if (extended->second.hasAfterHours) {
                    setNumber(object, "afterHoursPrice", extended->second.afterHours);
                }
                if (extended->second.hasOvernight) {
                    setNumber(object, "overnightPrice", extended->second.overnight);
                }
            }
        }
    } else {
        appendGap(gaps, "基本行情不可用");
    }
}

std::string tradeSymbol(const std::string &code, int securityMarket) {
    switch (securityMarket) {
    case Trd_Common::TrdSecMarket_HK: return "HK." + code;
    case Trd_Common::TrdSecMarket_US: return "US." + code;
    case Trd_Common::TrdSecMarket_CN_SH:
    case Trd_Common::TrdSecMarket_CN_SZ: return "CN." + code;
    case Trd_Common::TrdSecMarket_SG: return "SG." + code;
    case Trd_Common::TrdSecMarket_JP: return "JP." + code;
    case Trd_Common::TrdSecMarket_AU: return "AU." + code;
    case Trd_Common::TrdSecMarket_MY: return "MY." + code;
    case Trd_Common::TrdSecMarket_CA: return "CA." + code;
    default: return code;
    }
}

void appendOrder(
    google::protobuf::ListValue *list,
    const Trd_Common::Order &order
) {
    auto *object = list->add_values()->mutable_struct_value();
    setString(
        object,
        "orderId",
        order.has_orderidex() && !order.orderidex().empty()
            ? order.orderidex()
            : std::to_string(order.orderid())
    );
    setString(
        object,
        "symbol",
        tradeSymbol(order.code(), order.has_secmarket() ? order.secmarket() : 0)
    );
    setString(object, "name", order.name());
    setNumber(object, "side", order.trdside());
    setNumber(object, "status", order.orderstatus());
    setNumber(object, "quantity", order.qty());
    setNumber(object, "price", order.has_price() ? order.price() : 0);
    setNumber(object, "filledQuantity", order.has_fillqty() ? order.fillqty() : 0);
    if (order.has_fillavgprice()) {
        setNumber(object, "filledAveragePrice", order.fillavgprice());
    }
    setString(object, "createdAt", order.createtime());
    setString(object, "updatedAt", order.updatetime());
}

void appendFill(
    google::protobuf::ListValue *list,
    const Trd_Common::OrderFill &fill
) {
    auto *object = list->add_values()->mutable_struct_value();
    setString(
        object,
        "fillId",
        fill.has_fillidex() && !fill.fillidex().empty()
            ? fill.fillidex()
            : std::to_string(fill.fillid())
    );
    setString(
        object,
        "orderId",
        fill.has_orderidex() && !fill.orderidex().empty()
            ? fill.orderidex()
            : std::to_string(fill.orderid())
    );
    setString(
        object,
        "symbol",
        tradeSymbol(fill.code(), fill.has_secmarket() ? fill.secmarket() : 0)
    );
    setString(object, "name", fill.name());
    setNumber(object, "side", fill.trdside());
    setNumber(object, "quantity", fill.qty());
    setNumber(object, "price", fill.price());
    setString(object, "createdAt", fill.createtime());
}

std::string dateTimeDaysAgo(int days) {
    std::time_t value = std::time(nullptr) - static_cast<std::time_t>(days) * 86400;
    std::tm local {};
    localtime_r(&value, &local);
    char buffer[32] = {};
    std::strftime(buffer, sizeof(buffer), "%Y-%m-%d %H:%M:%S", &local);
    return buffer;
}

void loadTradeSnapshot(
    ChangFuFutuClient *client,
    const ChangFuFutuAccount &account,
    bool refreshCache,
    google::protobuf::Struct *root,
    google::protobuf::ListValue *gaps
) {
    auto *orders = (*root->mutable_fields())["openOrders"].mutable_list_value();
    auto *fills = (*root->mutable_fields())["recentDeals"].mutable_list_value();
    auto *historyOrders =
        (*root->mutable_fields())["historicalOrders"].mutable_list_value();
    auto *historyFills =
        (*root->mutable_fields())["historicalDeals"].mutable_list_value();
    bool currentOrderSucceeded = false;
    bool currentFillSucceeded = false;
    bool historyOrderSucceeded = false;
    bool historyFillSucceeded = false;
    std::vector<int> markets = account.markets;
    if (markets.empty()) {
        markets.push_back(Trd_Common::TrdMarket_HK);
    }
    const std::string beginTime = dateTimeDaysAgo(30);
    const std::string endTime = dateTimeDaysAgo(0);
    for (int market : markets) {
        auto configureHeader = [&](Trd_Common::TrdHeader *header) {
            header->set_trdenv(account.environment);
            header->set_accid(account.id);
            header->set_trdmarket(market);
        };

        Trd_GetOrderList::Request orderRequest;
        configureHeader(orderRequest.mutable_c2s()->mutable_header());
        orderRequest.mutable_c2s()->set_refreshcache(refreshCache);
        Trd_GetOrderList::Response orderResponse;
        ChangFuFutuStatus status = sendRequest(
            client,
            FTAPI_ProtoID_Trd_GetOrderList,
            orderRequest,
            &orderResponse
        );
        if (status == ChangFuFutuStatusOk
            && orderResponse.rettype() == Common::RetType_Succeed
            && orderResponse.has_s2c()) {
            currentOrderSucceeded = true;
            for (const auto &order : orderResponse.s2c().orderlist()) {
                appendOrder(orders, order);
            }
        }

        Trd_GetOrderFillList::Request fillRequest;
        configureHeader(fillRequest.mutable_c2s()->mutable_header());
        fillRequest.mutable_c2s()->set_refreshcache(refreshCache);
        Trd_GetOrderFillList::Response fillResponse;
        status = sendRequest(
            client,
            FTAPI_ProtoID_Trd_GetOrderFillList,
            fillRequest,
            &fillResponse
        );
        if (status == ChangFuFutuStatusOk
            && fillResponse.rettype() == Common::RetType_Succeed
            && fillResponse.has_s2c()) {
            currentFillSucceeded = true;
            for (const auto &fill : fillResponse.s2c().orderfilllist()) {
                appendFill(fills, fill);
            }
        }

        Trd_GetHistoryOrderList::Request historyOrderRequest;
        configureHeader(historyOrderRequest.mutable_c2s()->mutable_header());
        auto *orderFilter = historyOrderRequest.mutable_c2s()->mutable_filterconditions();
        orderFilter->set_begintime(beginTime);
        orderFilter->set_endtime(endTime);
        Trd_GetHistoryOrderList::Response historyOrderResponse;
        status = sendRequest(
            client,
            FTAPI_ProtoID_Trd_GetHistoryOrderList,
            historyOrderRequest,
            &historyOrderResponse
        );
        if (status == ChangFuFutuStatusOk
            && historyOrderResponse.rettype() == Common::RetType_Succeed
            && historyOrderResponse.has_s2c()) {
            historyOrderSucceeded = true;
            for (const auto &order : historyOrderResponse.s2c().orderlist()) {
                appendOrder(historyOrders, order);
            }
        }

        Trd_GetHistoryOrderFillList::Request historyFillRequest;
        configureHeader(historyFillRequest.mutable_c2s()->mutable_header());
        auto *fillFilter = historyFillRequest.mutable_c2s()->mutable_filterconditions();
        fillFilter->set_begintime(beginTime);
        fillFilter->set_endtime(endTime);
        Trd_GetHistoryOrderFillList::Response historyFillResponse;
        status = sendRequest(
            client,
            FTAPI_ProtoID_Trd_GetHistoryOrderFillList,
            historyFillRequest,
            &historyFillResponse
        );
        if (status == ChangFuFutuStatusOk
            && historyFillResponse.rettype() == Common::RetType_Succeed
            && historyFillResponse.has_s2c()) {
            historyFillSucceeded = true;
            for (const auto &fill : historyFillResponse.s2c().orderfilllist()) {
                appendFill(historyFills, fill);
            }
        }
    }
    if (!currentOrderSucceeded) appendGap(gaps, "当前订单不可用");
    if (!currentFillSucceeded) appendGap(gaps, "当前成交不可用");
    if (!historyOrderSucceeded) appendGap(gaps, "近 30 日历史订单不可用");
    if (!historyFillSucceeded) appendGap(gaps, "近 30 日历史成交不可用");
}

bool tradeMarketForSecurity(
    const Qot_Common::Security &security,
    int *tradeMarket,
    int *securityMarket
) {
    switch (security.market()) {
    case Qot_Common::QotMarket_US_Security:
        *tradeMarket = Trd_Common::TrdMarket_US;
        *securityMarket = Trd_Common::TrdSecMarket_US;
        return true;
    case Qot_Common::QotMarket_HK_Security:
        *tradeMarket = Trd_Common::TrdMarket_HK;
        *securityMarket = Trd_Common::TrdSecMarket_HK;
        return true;
    case Qot_Common::QotMarket_CNSH_Security:
        *tradeMarket = Trd_Common::TrdMarket_CN;
        *securityMarket = Trd_Common::TrdSecMarket_CN_SH;
        return true;
    case Qot_Common::QotMarket_CNSZ_Security:
        *tradeMarket = Trd_Common::TrdMarket_CN;
        *securityMarket = Trd_Common::TrdSecMarket_CN_SZ;
        return true;
    case Qot_Common::QotMarket_SG_Security:
        *tradeMarket = Trd_Common::TrdMarket_SG;
        *securityMarket = Trd_Common::TrdSecMarket_SG;
        return true;
    default:
        return false;
    }
}

bool parseAccountID(const char *raw, unsigned long long *accountID) {
    if (raw == nullptr || *raw == '\0') return false;
    try {
        std::size_t consumed = 0;
        const std::string value(raw);
        *accountID = std::stoull(value, &consumed);
        return consumed == value.size();
    } catch (...) {
        return false;
    }
}

ChangFuFutuStatus selectTradeAccount(
    ChangFuFutuClient *client,
    const char *accountID,
    int tradeMarket,
    ChangFuFutuAccount *selected
) {
    unsigned long long expected = 0;
    if (!parseAccountID(accountID, &expected)) {
        setError(client, "Futu 订单账户 ID 无效");
        return ChangFuFutuStatusInvalidArgument;
    }
    std::vector<ChangFuFutuAccount> accounts;
    ChangFuFutuStatus status = loadAccounts(client, &accounts);
    if (status != ChangFuFutuStatusOk) return status;
    std::vector<ChangFuFutuAccount> matches;
    for (const auto &account : accounts) {
        if (account.id == expected
            && account.environment == Trd_Common::TrdEnv_Real
            && account.accountStatus == Trd_Common::TrdAccStatus_Active
            && std::find(account.markets.begin(), account.markets.end(), tradeMarket)
                != account.markets.end()) {
            matches.push_back(account);
        }
    }
    if (matches.size() != 1) {
        setError(client, "Futu REAL 账户、状态或市场授权不匹配");
        return ChangFuFutuStatusOperationFailed;
    }
    *selected = matches.front();
    return ChangFuFutuStatusOk;
}

bool configureTrade(
    ChangFuFutuClient *client,
    const char *symbol,
    const char *side,
    const char *positionEffect,
    const char *orderType,
    const char *tradingSession,
    const char *timeInForce,
    double quantity,
    double limitPrice,
    Qot_Common::Security *security,
    std::string *canonicalSymbol,
    int *tradeMarket,
    int *securityMarket,
    int *tradeSide
) {
    if (symbol == nullptr || side == nullptr || positionEffect == nullptr
        || orderType == nullptr || tradingSession == nullptr || timeInForce == nullptr
        || !std::isfinite(quantity) || quantity <= 0 || std::floor(quantity) != quantity
        || !std::isfinite(limitPrice) || limitPrice <= 0) {
        setError(client, "Futu 订单参数无效");
        return false;
    }
    if (!parseProviderSymbol(symbol, security, canonicalSymbol)
        || !tradeMarketForSecurity(*security, tradeMarket, securityMarket)) {
        setError(client, "Futu 订单标的格式或市场不受支持");
        return false;
    }
    if (std::string(orderType) != "MARKETABLE_LIMIT"
        || std::string(timeInForce) != "DAY"
        || std::string(tradingSession) != "RTH") {
        setError(client, "Futu 当前只允许 MARKETABLE_LIMIT + DAY + RTH");
        return false;
    }
    const std::string direction(side);
    const std::string effect(positionEffect);
    if ((direction == "BUY" && (effect == "OPEN_LONG" || effect == "ADD_LONG"))
        || (direction == "BUY" && effect == "COVER_SHORT")) {
        *tradeSide = Trd_Common::TrdSide_Buy;
        return true;
    }
    if ((direction == "SELL" && effect == "REDUCE_LONG")
        || (direction == "SELL"
            && (effect == "OPEN_SHORT" || effect == "ADD_SHORT"))) {
        *tradeSide = Trd_Common::TrdSide_Sell;
        return true;
    }
    setError(client, "Futu 订单方向与 position effect 不匹配");
    return false;
}

bool configurePacketID(ChangFuFutuClient *client, Common::PacketID *packetID) {
    const auto connectionID = FTAPIChannel_GetConnectID(client->channel);
    if (connectionID == 0) {
        setError(client, "OpenD 连接 ID 无效，禁止发送真实交易请求");
        return false;
    }
    packetID->set_connid(connectionID);
    packetID->set_serialno(client->tradeSerial.fetch_add(1) + 1);
    return true;
}

void setBrokerResponseError(
    ChangFuFutuClient *client,
    int errorCode,
    const std::string &message
) {
    const std::string lower = uppercaseAscii(message);
    const bool locked = lower.find("UNLOCK") != std::string::npos
        || message.find("解锁") != std::string::npos
        || message.find("交易密码") != std::string::npos;
    if (locked) {
        setError(
            client,
            "FUTU_TRADE_LOCKED_EXTERNAL_ACTION_REQUIRED: "
            "Futu OpenD 尚未解锁交易，请在 OpenD 界面完成交易解锁后重新提交。"
        );
        return;
    }
    setError(
        client,
        "Futu 券商拒绝，错误码=" + std::to_string(errorCode)
            + (message.empty() ? "" : "，原因=" + message)
    );
}

std::string normalizedFutuOrderStatus(int status) {
    switch (status) {
    case Trd_Common::OrderStatus_Filled_All: return "FILLED";
    case Trd_Common::OrderStatus_Filled_Part: return "PARTIALLY_FILLED";
    case Trd_Common::OrderStatus_Cancelled_Part:
    case Trd_Common::OrderStatus_FillCancelled:
        return "PARTIAL_CANCELLED";
    case Trd_Common::OrderStatus_Cancelled_All:
    case Trd_Common::OrderStatus_Deleted:
        return "CANCELLED";
    case Trd_Common::OrderStatus_SubmitFailed:
    case Trd_Common::OrderStatus_Failed:
    case Trd_Common::OrderStatus_Disabled:
        return "REJECTED";
    case Trd_Common::OrderStatus_Cancelling_Part:
    case Trd_Common::OrderStatus_Cancelling_All:
        return "CANCEL_PENDING";
    case Trd_Common::OrderStatus_WaitingSubmit:
    case Trd_Common::OrderStatus_Submitting:
    case Trd_Common::OrderStatus_Submitted:
        return "SUBMITTED";
    default:
        return "UNKNOWN";
    }
}

void writeOrderReceipt(
    google::protobuf::Struct *root,
    const Trd_Common::Order &order,
    const std::string &fallbackRemark
) {
    setString(
        root,
        "brokerOrderId",
        order.has_orderidex() && !order.orderidex().empty()
            ? order.orderidex()
            : std::to_string(order.orderid())
    );
    setString(root, "status", normalizedFutuOrderStatus(order.orderstatus()));
    setNumber(root, "submittedQuantity", order.qty());
    setNumber(root, "filledQuantity", order.has_fillqty() ? order.fillqty() : 0);
    if (order.has_fillavgprice()) {
        setNumber(root, "filledAveragePrice", order.fillavgprice());
    }
    setString(
        root,
        "remark",
        order.has_remark() && !order.remark().empty() ? order.remark() : fallbackRemark
    );
    if (order.has_lasterrmsg() && !order.lasterrmsg().empty()) {
        setString(root, "brokerCode", order.lasterrmsg());
    }
    setString(
        root,
        "updatedAt",
        order.updatetime().empty() ? utcNow() : order.updatetime()
    );
}

ChangFuFutuStatus loadManagedOrders(
    ChangFuFutuClient *client,
    const ChangFuFutuAccount &account,
    int tradeMarket,
    std::vector<Trd_Common::Order> *orders
) {
    Trd_GetOrderList::Request request;
    auto *c2s = request.mutable_c2s();
    auto *header = c2s->mutable_header();
    header->set_trdenv(account.environment);
    header->set_accid(account.id);
    header->set_trdmarket(tradeMarket);
    c2s->set_refreshcache(true);
    Trd_GetOrderList::Response response;
    const ChangFuFutuStatus status = sendRequest(
        client,
        FTAPI_ProtoID_Trd_GetOrderList,
        request,
        &response
    );
    if (status != ChangFuFutuStatusOk) return status;
    if (response.rettype() != Common::RetType_Succeed || !response.has_s2c()) {
        setBrokerResponseError(
            client,
            response.has_errcode() ? response.errcode() : 0,
            response.has_retmsg() ? response.retmsg() : "查询订单失败"
        );
        return ChangFuFutuStatusOperationFailed;
    }
    orders->assign(response.s2c().orderlist().begin(), response.s2c().orderlist().end());
    return ChangFuFutuStatusOk;
}

bool sameOrderIdentity(
    const Trd_Common::Order &order,
    const std::string &remark,
    const std::string &code,
    int expectedSide,
    double quantity,
    double limitPrice
) {
    return order.has_remark() && order.remark() == remark
        && uppercaseAscii(order.code()) == uppercaseAscii(code)
        && (order.trdside() == expectedSide
            || (expectedSide == Trd_Common::TrdSide_Sell
                && order.trdside() == Trd_Common::TrdSide_SellShort)
            || (expectedSide == Trd_Common::TrdSide_Buy
                && order.trdside() == Trd_Common::TrdSide_BuyBack))
        && std::fabs(order.qty() - quantity) < 0.000001
        && order.has_price()
        && std::fabs(order.price() - limitPrice) < 0.000001;
}
}
#endif

ChangFuFutuClient *changfu_futu_create(void) {
    return new ChangFuFutuClient();
}

void changfu_futu_destroy(ChangFuFutuClient *client) {
    if (client == nullptr) {
        return;
    }
    changfu_futu_disconnect(client);
    delete client;
}

bool changfu_futu_sdk_available(void) {
#if defined(CHANGFU_FUTU_SDK_AVAILABLE)
    return true;
#else
    return false;
#endif
}

ChangFuFutuStatus changfu_futu_connect(
    ChangFuFutuClient *client,
    const char *host,
    uint16_t port
) {
    if (client == nullptr || host == nullptr) {
        return ChangFuFutuStatusInvalidArgument;
    }
    if (std::string(host) != "127.0.0.1" || port != 11111) {
        client->lastError = "仅允许连接本机 127.0.0.1:11111";
        return ChangFuFutuStatusInvalidArgument;
    }
#if defined(CHANGFU_FUTU_SDK_AVAILABLE)
    if (client->connected) {
        return ChangFuFutuStatusOk;
    }
    FTAPIChannel_Init();
    client->channel = CreateFTAPIChannel();
    if (client->channel == nullptr) {
        client->lastError = "无法创建 Futu SDK Channel";
        return ChangFuFutuStatusConnectionFailed;
    }
    {
        std::lock_guard<std::mutex> registryLock(registryMutex);
        clients[client->channel] = client;
    }
    FTAPIChannel_SetClientInfo(client->channel, "changfu-desktop", 100);
    FTAPIChannel_SetProgrammingLanguage(client->channel, "C++");
    FTAPIChannel_SetOnInitConnectCallback(client->channel, onInitConnect);
    FTAPIChannel_SetOnDisconnectCallback(client->channel, onDisconnect);
    FTAPIChannel_SetOnReplyCallback(client->channel, onReply);
    {
        std::lock_guard<std::mutex> lock(client->mutex);
        client->connectCompleted = false;
        client->connected = false;
        client->connectError = 0;
        client->tradeSerial.store(0);
        client->lastError.clear();
        client->replies.clear();
    }
    if (FTAPIChannel_InitConnect(client->channel, host, port, 0) != 0) {
        setError(client, "无法启动 OpenD 连接");
        changfu_futu_disconnect(client);
        return ChangFuFutuStatusConnectionFailed;
    }
    {
        std::unique_lock<std::mutex> lock(client->mutex);
        const bool completed = client->condition.wait_for(
            lock,
            std::chrono::seconds(10),
            [client] { return client->connectCompleted; }
        );
        if (!completed) {
            client->lastError = "OpenD 握手超时";
            return ChangFuFutuStatusTimeout;
        }
        if (!client->connected) {
            return ChangFuFutuStatusConnectionFailed;
        }
    }
    return ChangFuFutuStatusOk;
#else
    client->lastError = "未配置 Futu C++ SDK";
    return ChangFuFutuStatusSdkUnavailable;
#endif
}

void changfu_futu_disconnect(ChangFuFutuClient *client) {
    if (client == nullptr) {
        return;
    }
#if defined(CHANGFU_FUTU_SDK_AVAILABLE)
    FTAPIChannelPtr channel = client->channel;
    if (channel != nullptr) {
        FTAPIChannel_SetOnInitConnectCallback(channel, nullptr);
        FTAPIChannel_SetOnDisconnectCallback(channel, nullptr);
        FTAPIChannel_SetOnReplyCallback(channel, nullptr);
        {
            std::lock_guard<std::mutex> registryLock(registryMutex);
            clients.erase(channel);
        }
        FTAPIChannel_Close(channel);
        ReleaseFTAPIChannel(channel);
        client->channel = nullptr;
        FTAPIChannel_UnInit();
    }
#endif
    {
        std::lock_guard<std::mutex> lock(client->mutex);
        client->connected = false;
        client->connectCompleted = false;
        client->tradeSerial.store(0);
        client->replies.clear();
    }
    client->condition.notify_all();
}

bool changfu_futu_is_connected(const ChangFuFutuClient *client) {
    if (client == nullptr) {
        return false;
    }
    std::lock_guard<std::mutex> lock(client->mutex);
    return client->connected;
}

ChangFuFutuStatus changfu_futu_load_snapshot_json(
    ChangFuFutuClient *client,
    bool refreshCache,
    const char *additionalSymbolsCsv,
    char **json
) {
    if (client == nullptr || additionalSymbolsCsv == nullptr || json == nullptr) {
        return ChangFuFutuStatusInvalidArgument;
    }
    *json = nullptr;
#if defined(CHANGFU_FUTU_SDK_AVAILABLE)
    if (!changfu_futu_is_connected(client)) {
        setError(client, "OpenD 尚未连接");
        return ChangFuFutuStatusConnectionFailed;
    }

    std::vector<ChangFuFutuAccount> accounts;
    ChangFuFutuStatus status = loadAccounts(client, &accounts);
    if (status != ChangFuFutuStatusOk) {
        return status;
    }
    const ChangFuFutuAccount &account = accounts.front();
    const int market = preferredMarket(account.markets);
    const int currency = currencyForMarket(market);

    Trd_Common::Funds funds;
    status = loadFunds(client, account, market, currency, refreshCache, &funds);
    if (status != ChangFuFutuStatusOk) {
        return status;
    }

    std::vector<std::pair<int, Trd_Common::Position>> positions;
    status = loadPositions(client, account, refreshCache, &positions);
    if (status != ChangFuFutuStatusOk) {
        return status;
    }

    std::string marketName;
    std::string marketState;
    int marketStateValue = 0;
    loadMarketState(client, market, &marketName, &marketState, &marketStateValue);

    google::protobuf::Struct root;
    google::protobuf::Struct *accountObject =
        (*root.mutable_fields())["account"].mutable_struct_value();
    setString(accountObject, "accountId", std::to_string(account.id));
    setString(
        accountObject,
        "environment",
        account.environment == Trd_Common::TrdEnv_Real ? "REAL" : "SIMULATE"
    );
    setNumber(accountObject, "totalAssets", funds.totalassets());
    setNumber(accountObject, "cash", funds.cash());
    setNumber(accountObject, "buyingPower", funds.power());
    if (funds.has_unrealizedpl()) {
        setNumber(accountObject, "unrealizedProfit", funds.unrealizedpl());
    }
    if (funds.has_realizedpl()) {
        setNumber(accountObject, "realizedProfit", funds.realizedpl());
    }
    setString(accountObject, "currency", currencyCode(currency));
    setBool(
        accountObject,
        "marginAccount",
        account.accountType == Trd_Common::TrdAccType_Margin
    );
    setBool(
        accountObject,
        "marginCallActive",
        (funds.has_margincallmargin() && funds.margincallmargin() > 0)
            || (funds.has_risklevel()
                && funds.risklevel() == Trd_Common::CltRiskLevel_Danger)
    );

    google::protobuf::ListValue *positionList =
        (*root.mutable_fields())["positions"].mutable_list_value();
    for (const auto &entry : positions) {
        const Trd_Common::Position &position = entry.second;
        google::protobuf::Struct *positionObject =
            positionList->add_values()->mutable_struct_value();
        setString(positionObject, "id", std::to_string(position.positionid()));
        const std::string prefix = marketPrefix(position, entry.first);
        setString(
            positionObject,
            "symbol",
            prefix.empty() ? position.code() : prefix + "." + position.code()
        );
        setString(positionObject, "name", position.name());
        setNumber(positionObject, "quantity", position.qty());
        setNumber(positionObject, "lastPrice", position.price());
        if (position.has_averagecostprice()) {
            setNumber(positionObject, "costPrice", position.averagecostprice());
        } else if (position.has_dilutedcostprice()) {
            setNumber(positionObject, "costPrice", position.dilutedcostprice());
        } else if (position.has_costprice()) {
            setNumber(positionObject, "costPrice", position.costprice());
        }
        if (position.has_td_plval()) {
            setNumber(positionObject, "todayProfit", position.td_plval());
        }
        setString(
            positionObject,
            "currency",
            currencyCode(position.has_currency() ? position.currency() : currency)
        );
    }

    google::protobuf::Struct *marketObject =
        (*root.mutable_fields())["market"].mutable_struct_value();
    setString(marketObject, "name", marketName);
    setString(marketObject, "state", marketState);
    setNumber(marketObject, "stateValue", marketStateValue);

    google::protobuf::ListValue *dataGaps =
        (*root.mutable_fields())["dataGaps"].mutable_list_value();
    loadQuoteSnapshot(client, positions, additionalSymbolsCsv, &root, dataGaps);
    loadTradeSnapshot(client, account, refreshCache, &root, dataGaps);

    std::string output;
    google::protobuf::util::JsonPrintOptions options;
    options.add_whitespace = false;
    const auto jsonStatus =
        google::protobuf::util::MessageToJsonString(root, &output, options);
    if (!jsonStatus.ok()) {
        setError(client, "Futu 快照 JSON 编码失败");
        return ChangFuFutuStatusOperationFailed;
    }
    char *buffer = static_cast<char *>(std::malloc(output.size() + 1));
    if (buffer == nullptr) {
        setError(client, "Futu 快照内存分配失败");
        return ChangFuFutuStatusOperationFailed;
    }
    std::memcpy(buffer, output.c_str(), output.size() + 1);
    *json = buffer;
    setError(client, "");
    return ChangFuFutuStatusOk;
#else
    client->lastError = "未配置 Futu C++ SDK";
    return ChangFuFutuStatusSdkUnavailable;
#endif
}

ChangFuFutuStatus changfu_futu_search_instruments_json(
    ChangFuFutuClient *client,
    const char *query,
    const char *marketsCsv,
    const char *instrumentTypesCsv,
    uint32_t limit,
    char **json
) {
    if (client == nullptr || query == nullptr || marketsCsv == nullptr
        || instrumentTypesCsv == nullptr || json == nullptr) {
        return ChangFuFutuStatusInvalidArgument;
    }
    *json = nullptr;
#if defined(CHANGFU_FUTU_SDK_AVAILABLE)
    if (!changfu_futu_is_connected(client)) {
        setError(client, "OpenD 尚未连接");
        return ChangFuFutuStatusConnectionFailed;
    }
    const std::string normalizedQuery(query);
    if (normalizedQuery.empty()) {
        setError(client, "搜索关键词不能为空");
        return ChangFuFutuStatusInvalidArgument;
    }

    const std::string marketFilter(marketsCsv);
    const std::string typeFilter(instrumentTypesCsv);
    google::protobuf::Struct root;
    setString(&root, "providerId", "FUTU");
    setString(&root, "query", normalizedQuery);
    setString(&root, "queryMode", "FUZZY");
    setString(&root, "fetchedAt", utcNow());
    auto *results = (*root.mutable_fields())["results"].mutable_list_value();

    std::vector<Qot_Common::Security> exactSecurities;
    if (exactSearchSecurity(normalizedQuery, marketFilter, &exactSecurities)) {
        Qot_GetStaticInfo::Request staticRequest;
        for (const auto &security : exactSecurities) {
            staticRequest.mutable_c2s()->add_securitylist()->CopyFrom(security);
        }
        Qot_GetStaticInfo::Response staticResponse;
        const ChangFuFutuStatus staticStatus = sendRequest(
            client,
            FTAPI_ProtoID_Qot_GetStaticInfo,
            staticRequest,
            &staticResponse
        );
        if (staticStatus == ChangFuFutuStatusOk
            && staticResponse.rettype() == Common::RetType_Succeed
            && staticResponse.has_s2c()) {
            for (const auto &info : staticResponse.s2c().staticinfolist()) {
                if (!info.has_basic()) {
                    continue;
                }
                const auto &basic = info.basic();
                std::string market;
                std::string currency;
                if (!brokerMarket(basic.security().market(), &market, &currency)
                    || !csvContains(marketFilter, market)) {
                    continue;
                }
                std::string instrumentType;
                bool addable = !basic.delisting();
                std::string unavailableReason =
                    addable ? "" : "该标的已退市，不能加入标的池";
                switch (basic.sectype()) {
                case Qot_Common::SecurityType_Eqty:
                    instrumentType = "STOCK";
                    break;
                case Qot_Common::SecurityType_Trust:
                    instrumentType = "ETF";
                    if (!isRecognizableETF(basic.name())) {
                        addable = false;
                        unavailableReason = "Futu 将该标的归为 Trust，无法确认是否为 ETF";
                    }
                    break;
                default:
                    continue;
                }
                if (!csvContains(typeFilter, instrumentType)) {
                    continue;
                }
                const std::string symbol =
                    quotePrefix(basic.security().market()) + "." + basic.security().code();
                auto *item = results->add_values()->mutable_struct_value();
                setString(item, "providerId", "FUTU");
                setString(item, "providerSymbol", symbol);
                setString(item, "canonicalSymbol", symbol);
                setString(item, "displayName", basic.name());
                setString(item, "market", market);
                setString(item, "instrumentType", instrumentType);
                setString(item, "currency", currency);
                setBool(item, "addable", addable);
                if (!unavailableReason.empty()) {
                    setString(item, "unavailableReason", unavailableReason);
                }
            }
            if (results->values_size() > 0) {
                return writeJson(client, root, "标的搜索", json);
            }
        }
    }

    Qot_GetSearchQuote::Request request;
    request.mutable_c2s()->set_keyword(normalizedQuery);
    request.mutable_c2s()->set_max_count(
        static_cast<int>(std::max<uint32_t>(1, std::min<uint32_t>(limit, 100)))
    );
    Qot_GetSearchQuote::Response response;
    ChangFuFutuStatus status = sendRequest(
        client,
        FTAPI_ProtoID_Qot_GetSearchQuote,
        request,
        &response
    );
    if (status != ChangFuFutuStatusOk) {
        return status;
    }
    if (response.rettype() != Common::RetType_Succeed || !response.has_s2c()) {
        const std::string message = response.retmsg();
        if (message == "Unknown protocol ID.") {
            std::vector<FuzzySecurityCandidate> candidates;
            if (loadStaticSearchCandidates(
                    client,
                    normalizedQuery,
                    marketFilter,
                    typeFilter,
                    &candidates
                )) {
                const std::size_t resultLimit = std::min<std::size_t>(
                    candidates.size(),
                    std::max<uint32_t>(1, std::min<uint32_t>(limit, 100))
                );
                for (std::size_t index = 0; index < resultLimit; ++index) {
                    const auto &candidate = candidates[index];
                    auto *item = results->add_values()->mutable_struct_value();
                    setString(item, "providerId", "FUTU");
                    setString(item, "providerSymbol", candidate.providerSymbol);
                    setString(item, "canonicalSymbol", candidate.providerSymbol);
                    setString(item, "displayName", candidate.displayName);
                    setString(item, "market", candidate.market);
                    setString(item, "instrumentType", candidate.instrumentType);
                    setString(item, "currency", candidate.currency);
                    setBool(item, "addable", candidate.addable);
                    if (!candidate.unavailableReason.empty()) {
                        setString(
                            item,
                            "unavailableReason",
                            candidate.unavailableReason
                        );
                    }
                }
                return writeJson(client, root, "标的搜索", json);
            }
        }
        setError(
            client,
            message == "Unknown protocol ID."
                ? "当前 OpenD 无法加载证券目录，请检查行情权限或升级 OpenD"
                : (message.empty() ? "Futu 标的搜索失败" : message)
        );
        return ChangFuFutuStatusOperationFailed;
    }

    for (const auto &quote : response.s2c().search_quote_list()) {
        std::string market;
        std::string currency;
        if (!brokerMarket(quote.market(), &market, &currency)
            || !csvContains(marketFilter, market)
            || quote.code().empty()) {
            continue;
        }

        std::string instrumentType;
        bool addable = true;
        std::string unavailableReason;
        switch (quote.sec_type()) {
        case Qot_Common::SecurityType_Eqty:
            instrumentType = "STOCK";
            break;
        case Qot_Common::SecurityType_Trust:
            instrumentType = "ETF";
            if (!isRecognizableETF(quote.name())) {
                addable = false;
                unavailableReason = "Futu 将该标的归为 Trust，无法确认是否为 ETF";
            }
            break;
        case Qot_Common::SecurityType_Drvt:
            instrumentType = "OPTION";
            addable = false;
            unavailableReason = "请通过期权链选择完整期权合约";
            break;
        default:
            continue;
        }
        if (!csvContains(typeFilter, instrumentType)) {
            continue;
        }

        const std::string symbol = quotePrefix(quote.market()) + "." + quote.code();
        auto *item = results->add_values()->mutable_struct_value();
        setString(item, "providerId", "FUTU");
        setString(item, "providerSymbol", symbol);
        setString(item, "canonicalSymbol", symbol);
        setString(item, "displayName", quote.name().empty() ? quote.code() : quote.name());
        setString(item, "market", market);
        setString(item, "instrumentType", instrumentType);
        setString(item, "currency", currency);
        setBool(item, "addable", addable);
        if (!unavailableReason.empty()) {
            setString(item, "unavailableReason", unavailableReason);
        }
    }
    return writeJson(client, root, "标的搜索", json);
#else
    client->lastError = "未配置 Futu C++ SDK";
    return ChangFuFutuStatusSdkUnavailable;
#endif
}

ChangFuFutuStatus changfu_futu_option_expiries_json(
    ChangFuFutuClient *client,
    const char *underlyingSymbol,
    char **json
) {
    if (client == nullptr || underlyingSymbol == nullptr || json == nullptr) {
        return ChangFuFutuStatusInvalidArgument;
    }
    *json = nullptr;
#if defined(CHANGFU_FUTU_SDK_AVAILABLE)
    if (!changfu_futu_is_connected(client)) {
        setError(client, "OpenD 尚未连接");
        return ChangFuFutuStatusConnectionFailed;
    }
    Qot_Common::Security owner;
    std::string canonicalSymbol;
    if (!parseProviderSymbol(underlyingSymbol, &owner, &canonicalSymbol)) {
        setError(client, "Futu 标的代码必须包含市场，例如 US.AAPL 或 HK.00700");
        return ChangFuFutuStatusInvalidArgument;
    }

    Qot_GetOptionExpirationDate::Request request;
    request.mutable_c2s()->mutable_owner()->CopyFrom(owner);
    Qot_GetOptionExpirationDate::Response response;
    ChangFuFutuStatus status = sendRequest(
        client,
        FTAPI_ProtoID_Qot_GetOptionExpirationDate,
        request,
        &response
    );
    if (status != ChangFuFutuStatusOk) {
        return status;
    }
    if (response.rettype() != Common::RetType_Succeed || !response.has_s2c()) {
        setError(client, response.retmsg().empty() ? "Futu 期权到期日查询失败" : response.retmsg());
        return ChangFuFutuStatusOperationFailed;
    }

    google::protobuf::Struct root;
    setString(&root, "providerId", "FUTU");
    setString(&root, "underlyingSymbol", canonicalSymbol);
    setString(&root, "fetchedAt", utcNow());
    auto *expiries = (*root.mutable_fields())["expiries"].mutable_list_value();
    for (const auto &date : response.s2c().datelist()) {
        if (date.striketime().empty()) {
            continue;
        }
        auto *item = expiries->add_values()->mutable_struct_value();
        setString(item, "underlyingSymbol", canonicalSymbol);
        setString(item, "expiryDate", date.striketime());
    }
    return writeJson(client, root, "期权到期日", json);
#else
    client->lastError = "未配置 Futu C++ SDK";
    return ChangFuFutuStatusSdkUnavailable;
#endif
}

ChangFuFutuStatus changfu_futu_option_chain_json(
    ChangFuFutuClient *client,
    const char *underlyingSymbol,
    const char *expiryDate,
    char **json
) {
    if (client == nullptr || underlyingSymbol == nullptr || expiryDate == nullptr
        || json == nullptr) {
        return ChangFuFutuStatusInvalidArgument;
    }
    *json = nullptr;
#if defined(CHANGFU_FUTU_SDK_AVAILABLE)
    if (!changfu_futu_is_connected(client)) {
        setError(client, "OpenD 尚未连接");
        return ChangFuFutuStatusConnectionFailed;
    }
    Qot_Common::Security owner;
    std::string canonicalSymbol;
    if (!parseProviderSymbol(underlyingSymbol, &owner, &canonicalSymbol)) {
        setError(client, "Futu 标的代码必须包含市场，例如 US.AAPL 或 HK.00700");
        return ChangFuFutuStatusInvalidArgument;
    }
    const std::string expiry(expiryDate);
    if (expiry.empty()) {
        setError(client, "期权到期日不能为空");
        return ChangFuFutuStatusInvalidArgument;
    }

    Qot_GetOptionChain::Request request;
    auto *parameters = request.mutable_c2s();
    parameters->mutable_owner()->CopyFrom(owner);
    parameters->set_begintime(expiry);
    parameters->set_endtime(expiry);
    Qot_GetOptionChain::Response response;
    ChangFuFutuStatus status = sendRequest(
        client,
        FTAPI_ProtoID_Qot_GetOptionChain,
        request,
        &response
    );
    if (status != ChangFuFutuStatusOk) {
        return status;
    }
    if (response.rettype() != Common::RetType_Succeed || !response.has_s2c()) {
        setError(client, response.retmsg().empty() ? "Futu 期权链查询失败" : response.retmsg());
        return ChangFuFutuStatusOperationFailed;
    }

    google::protobuf::Struct root;
    setString(&root, "providerId", "FUTU");
    setString(&root, "underlyingSymbol", canonicalSymbol);
    setString(&root, "expiryDate", expiry);
    setString(&root, "fetchedAt", utcNow());
    auto *contracts = (*root.mutable_fields())["contracts"].mutable_list_value();
    for (const auto &chain : response.s2c().optionchain()) {
        if (chain.striketime() != expiry) {
            continue;
        }
        for (const auto &option : chain.option()) {
            const Qot_Common::SecurityStaticInfo *items[] = {
                option.has_call() ? &option.call() : nullptr,
                option.has_put() ? &option.put() : nullptr
            };
            for (const auto *info : items) {
                if (info == nullptr || !info->has_basic() || !info->has_optionexdata()) {
                    continue;
                }
                const auto &basic = info->basic();
                const auto &details = info->optionexdata();
                std::string market;
                std::string currency;
                const bool hasMarket = basic.has_security()
                    && brokerMarket(basic.security().market(), &market, &currency);
                const bool hasSymbol = basic.has_security()
                    && !basic.security().code().empty();
                const bool hasType = details.type() == Qot_Common::OptionType_Call
                    || details.type() == Qot_Common::OptionType_Put;
                const bool addable = hasMarket
                    && hasSymbol
                    && hasType
                    && basic.sectype() == Qot_Common::SecurityType_Drvt
                    && details.striketime() == expiry;
                const std::string providerSymbol = hasMarket && hasSymbol
                    ? market + "." + basic.security().code()
                    : "";

                auto *contract = contracts->add_values()->mutable_struct_value();
                setString(contract, "providerId", "FUTU");
                setString(contract, "providerSymbol", providerSymbol);
                setString(contract, "canonicalSymbol", providerSymbol);
                setString(
                    contract,
                    "displayName",
                    basic.name().empty() ? basic.security().code() : basic.name()
                );
                setString(contract, "market", hasMarket ? market : quotePrefix(owner.market()));
                setString(contract, "instrumentType", "OPTION");
                setString(
                    contract,
                    "optionType",
                    details.type() == Qot_Common::OptionType_Put ? "PUT" : "CALL"
                );
                setString(contract, "underlyingSymbol", canonicalSymbol);
                setString(contract, "expiryDate", details.striketime());
                setString(contract, "strikePrice", decimalString(details.strikeprice()));
                setString(contract, "currency", hasMarket ? currency : "");
                setString(contract, "contractMultiplier", std::to_string(basic.lotsize()));
                setBool(contract, "addable", addable);
                if (!addable) {
                    setString(contract, "unavailableReason", "Futu 期权合约元数据不完整");
                }
            }
        }
    }
    return writeJson(client, root, "期权链", json);
#else
    client->lastError = "未配置 Futu C++ SDK";
    return ChangFuFutuStatusSdkUnavailable;
#endif
}

ChangFuFutuStatus changfu_futu_option_quotes_json(
    ChangFuFutuClient *client,
    const char *optionSymbolsCsv,
    char **json
) {
    if (client == nullptr || optionSymbolsCsv == nullptr || json == nullptr) {
        return ChangFuFutuStatusInvalidArgument;
    }
    *json = nullptr;
#if defined(CHANGFU_FUTU_SDK_AVAILABLE)
    if (!changfu_futu_is_connected(client)) {
        setError(client, "OpenD 尚未连接");
        return ChangFuFutuStatusConnectionFailed;
    }

    const std::vector<std::string> symbols = splitCsv(optionSymbolsCsv, 100);
    if (symbols.empty()) {
        setError(client, "期权快照至少需要一个合约代码");
        return ChangFuFutuStatusInvalidArgument;
    }
    Qot_GetSecuritySnapshot::Request request;
    for (const auto &symbol : symbols) {
        Qot_Common::Security security;
        if (quoteSecurityForSymbol(symbol, &security)) {
            request.mutable_c2s()->add_securitylist()->CopyFrom(security);
        }
    }
    if (request.c2s().securitylist_size() == 0) {
        setError(client, "期权合约代码格式无效");
        return ChangFuFutuStatusInvalidArgument;
    }

    Qot_GetSecuritySnapshot::Response response;
    const ChangFuFutuStatus status = sendRequest(
        client,
        FTAPI_ProtoID_Qot_GetSecuritySnapshot,
        request,
        &response
    );
    if (status != ChangFuFutuStatusOk) {
        return status;
    }
    if (response.rettype() != Common::RetType_Succeed || !response.has_s2c()) {
        setError(client, response.retmsg().empty() ? "期权快照请求失败" : response.retmsg());
        return ChangFuFutuStatusOperationFailed;
    }

    google::protobuf::Struct root;
    setString(&root, "providerId", "FUTU");
    setString(&root, "fetchedAt", utcFromEpoch(std::time(nullptr)));
    auto *quotes = (*root.mutable_fields())["quotes"].mutable_list_value();
    auto *gaps = (*root.mutable_fields())["dataGaps"].mutable_list_value();
    std::set<std::string> returned;
    for (const auto &snapshot : response.s2c().snapshotlist()) {
        if (!snapshot.has_basic()) {
            continue;
        }
        const auto &basic = snapshot.basic();
        const std::string symbol = quoteSymbol(basic.security());
        returned.insert(symbol);
        auto *object = quotes->add_values()->mutable_struct_value();
        setString(object, "code", symbol);
        if (basic.has_curprice()) setNumber(object, "lastPrice", basic.curprice());
        if (basic.has_bidprice()) setNumber(object, "bid", basic.bidprice());
        if (basic.has_askprice()) setNumber(object, "ask", basic.askprice());
        if (basic.has_volume()) {
            setNumber(object, "volume", static_cast<double>(basic.volume()));
        }
        if (snapshot.has_optionexdata()) {
            const auto &option = snapshot.optionexdata();
            if (option.has_delta()) setNumber(object, "delta", option.delta());
            if (option.has_impliedvolatility()) {
                setNumber(object, "impliedVolatility", option.impliedvolatility());
            }
            if (option.has_openinterest()) {
                setNumber(object, "openInterest", option.openinterest());
            }
        } else {
            appendGap(gaps, symbol + " 未返回期权希腊值");
        }
    }
    for (const auto &symbol : symbols) {
        if (returned.find(symbol) == returned.end()) {
            appendGap(gaps, symbol + " 期权快照不可用");
        }
    }
    return writeJson(client, root, "期权快照", json);
#else
    client->lastError = "未配置 Futu C++ SDK";
    return ChangFuFutuStatusSdkUnavailable;
#endif
}

ChangFuFutuStatus changfu_futu_sell_put_underlying_json(
    ChangFuFutuClient *client,
    const char *symbol,
    char **json
) {
    if (client == nullptr || symbol == nullptr || json == nullptr) {
        return ChangFuFutuStatusInvalidArgument;
    }
    *json = nullptr;
#if defined(CHANGFU_FUTU_SDK_AVAILABLE)
    if (!changfu_futu_is_connected(client)) {
        setError(client, "OpenD 尚未连接");
        return ChangFuFutuStatusConnectionFailed;
    }
    Qot_Common::Security security;
    if (!quoteSecurityForSymbol(symbol, &security)) {
        setError(client, "正股代码格式无效");
        return ChangFuFutuStatusInvalidArgument;
    }

    google::protobuf::Struct root;
    setString(&root, "providerId", "FUTU");
    setString(&root, "symbol", quoteSymbol(security));
    setString(&root, "capturedAt", utcFromEpoch(std::time(nullptr)));
    auto *gaps = (*root.mutable_fields())["dataGaps"].mutable_list_value();

    Qot_GetSecuritySnapshot::Request snapshotRequest;
    snapshotRequest.mutable_c2s()->add_securitylist()->CopyFrom(security);
    Qot_GetSecuritySnapshot::Response snapshotResponse;
    ChangFuFutuStatus status = sendRequest(
        client,
        FTAPI_ProtoID_Qot_GetSecuritySnapshot,
        snapshotRequest,
        &snapshotResponse
    );
    if (status == ChangFuFutuStatusOk
        && snapshotResponse.rettype() == Common::RetType_Succeed
        && snapshotResponse.has_s2c()
        && snapshotResponse.s2c().snapshotlist_size() > 0
        && snapshotResponse.s2c().snapshotlist(0).has_basic()) {
        const auto &snapshot = snapshotResponse.s2c().snapshotlist(0);
        const auto &basic = snapshot.basic();
        if (basic.has_curprice()) setNumber(&root, "currentPrice", basic.curprice());
        else appendGap(gaps, "正股现价不可用");
        if (snapshot.has_equityexdata()) {
            const auto &equity = snapshot.equityexdata();
            if (equity.has_issuedmarketval()) {
                setNumber(&root, "marketCap", equity.issuedmarketval());
            } else if (equity.has_outstandingmarketval()) {
                setNumber(&root, "marketCap", equity.outstandingmarketval());
            } else {
                appendGap(gaps, "总市值不可用");
            }
            if (equity.has_pettmrate()) {
                setNumber(&root, "peRatio", equity.pettmrate());
            } else if (equity.has_perate()) {
                setNumber(&root, "peRatio", equity.perate());
            } else {
                appendGap(gaps, "市盈率不可用");
            }
        } else {
            appendGap(gaps, "估值快照不可用");
        }
    } else {
        appendGap(gaps, "正股快照不可用");
    }

    Qot_Sub::Request subscriptionRequest;
    subscriptionRequest.mutable_c2s()->add_securitylist()->CopyFrom(security);
    subscriptionRequest.mutable_c2s()->add_subtypelist(Qot_Common::SubType_KL_Day);
    subscriptionRequest.mutable_c2s()->set_issuborunsub(true);
    subscriptionRequest.mutable_c2s()->set_isregorunregpush(false);
    Qot_Sub::Response subscriptionResponse;
    status = sendRequest(client, FTAPI_ProtoID_Qot_Sub, subscriptionRequest, &subscriptionResponse);

    Qot_GetKL::Request barRequest;
    barRequest.mutable_c2s()->mutable_security()->CopyFrom(security);
    barRequest.mutable_c2s()->set_rehabtype(Qot_Common::RehabType_Forward);
    barRequest.mutable_c2s()->set_kltype(Qot_Common::KLType_Day);
    barRequest.mutable_c2s()->set_reqnum(260);
    Qot_GetKL::Response barResponse;
    status = sendRequest(client, FTAPI_ProtoID_Qot_GetKL, barRequest, &barResponse);
    if (status == ChangFuFutuStatusOk
        && barResponse.rettype() == Common::RetType_Succeed
        && barResponse.has_s2c()
        && barResponse.s2c().kllist_size() >= 2) {
        std::vector<double> closes;
        closes.reserve(barResponse.s2c().kllist_size());
        for (const auto &bar : barResponse.s2c().kllist()) {
            if (bar.closeprice() > 0) closes.push_back(bar.closeprice());
        }
        const auto movingAverage = [&](std::size_t periods) -> double {
            if (closes.size() < periods) return 0;
            double sum = 0;
            for (std::size_t index = closes.size() - periods; index < closes.size(); ++index) {
                sum += closes[index];
            }
            return sum / static_cast<double>(periods);
        };
        const auto trend = [&](std::size_t periods) -> double {
            if (closes.size() <= periods || closes[closes.size() - 1 - periods] <= 0) return 0;
            return ((closes.back() / closes[closes.size() - 1 - periods]) - 1) * 100;
        };
        if (closes.size() > 30) {
            setNumber(&root, "change30dPercent", trend(30));
            setNumber(&root, "trend20d", trend(20));
            setNumber(&root, "trend30d", trend(30));
        } else {
            appendGap(gaps, "30 日涨跌不可用");
        }
        if (closes.size() > 60) setNumber(&root, "trend60d", trend(60));
        else appendGap(gaps, "60 日趋势不可用");
        if (closes.size() > 120) setNumber(&root, "trend120d", trend(120));
        else appendGap(gaps, "120 日趋势不可用");
        if (closes.size() >= 50) setNumber(&root, "ma50", movingAverage(50));
        else appendGap(gaps, "MA50 不可用");
        if (closes.size() >= 200) setNumber(&root, "ma200", movingAverage(200));
        else appendGap(gaps, "MA200 不可用");
        if (closes.size() >= 15) {
            double gains = 0;
            double losses = 0;
            for (std::size_t index = closes.size() - 14; index < closes.size(); ++index) {
                const double delta = closes[index] - closes[index - 1];
                if (delta >= 0) gains += delta;
                else losses -= delta;
            }
            const double averageGain = gains / 14.0;
            const double averageLoss = losses / 14.0;
            setNumber(
                &root,
                "rsi14",
                averageLoss == 0 ? 100.0 : 100.0 - (100.0 / (1.0 + averageGain / averageLoss))
            );
        } else {
            appendGap(gaps, "RSI14 不可用");
        }
        if (closes.size() >= 31) {
            std::vector<double> returns;
            for (std::size_t index = closes.size() - 30; index < closes.size(); ++index) {
                returns.push_back(std::log(closes[index] / closes[index - 1]));
            }
            double mean = 0;
            for (double value : returns) mean += value;
            mean /= static_cast<double>(returns.size());
            double variance = 0;
            for (double value : returns) variance += (value - mean) * (value - mean);
            variance /= static_cast<double>(returns.size() - 1);
            setNumber(&root, "realizedVol30d", std::sqrt(variance * 252.0) * 100);
        } else {
            appendGap(gaps, "30 日实现波动率不可用");
        }
        if (!closes.empty()) {
            const auto rangeStart = closes.size() > 252 ? closes.end() - 252 : closes.begin();
            const double high = *std::max_element(rangeStart, closes.end());
            const double low = *std::min_element(rangeStart, closes.end());
            if (high > 0) setNumber(&root, "distanceTo52wHigh", ((closes.back() / high) - 1) * 100);
            if (low > 0) setNumber(&root, "distanceTo52wLow", ((closes.back() / low) - 1) * 100);
        }
    } else {
        appendGap(gaps, "30 日 K 线不可用");
    }
    return writeJson(client, root, "SELL PUT 正股快照", json);
#else
    client->lastError = "未配置 Futu C++ SDK";
    return ChangFuFutuStatusSdkUnavailable;
#endif
}

ChangFuFutuStatus changfu_futu_market_intelligence_json(
    ChangFuFutuClient *client,
    const char *symbolsCsv,
    char **json
) {
    if (client == nullptr || symbolsCsv == nullptr || json == nullptr) {
        return ChangFuFutuStatusInvalidArgument;
    }
    *json = nullptr;
#if defined(CHANGFU_FUTU_SDK_AVAILABLE)
    if (!changfu_futu_is_connected(client)) {
        setError(client, "OpenD 尚未连接");
        return ChangFuFutuStatusConnectionFailed;
    }

    const std::time_t now = std::time(nullptr);
    const std::string fetchedAt = utcFromEpoch(now);
    const std::vector<std::string> symbols = splitCsv(symbolsCsv, 12);
    google::protobuf::Struct root;
    setString(&root, "providerId", "FUTU");
    setString(&root, "fetchedAt", fetchedAt);
    auto *sections = (*root.mutable_fields())["sections"].mutable_list_value();

    auto appendSection = [&](const char *group) {
        auto *section = sections->add_values()->mutable_struct_value();
        setString(section, "group", group);
        return section;
    };

    auto *macroSection = appendSection("US_MACRO");
    auto *macroEvents = (*macroSection->mutable_fields())["events"].mutable_list_value();
    std::vector<std::string> macroErrors;
    bool economicSucceeded = false;
    bool fedWatchSucceeded = false;

    Qot_GetEconomicCalendar::Request economicRequest;
    auto *economicC2S = economicRequest.mutable_c2s();
    economicC2S->set_begindate(calendarDate(now - 86400));
    economicC2S->set_enddate(calendarDate(now + 14 * 86400));
    economicC2S->add_marketlist(Qot_Common::QotMarket_US_Security);
    economicC2S->set_count(80);
    Qot_GetEconomicCalendar::Response economicResponse;
    ChangFuFutuStatus status = sendRequest(
        client,
        FTAPI_ProtoID_Qot_GetEconomicCalendar,
        economicRequest,
        &economicResponse
    );
    if (status == ChangFuFutuStatusOk
        && economicResponse.rettype() == Common::RetType_Succeed
        && economicResponse.has_s2c()) {
        economicSucceeded = true;
        for (const auto &item : economicResponse.s2c().itemlist()) {
            if (!isTechnologyMacroEvent(item.title())) {
                continue;
            }
            const std::string publishedAt = item.has_timestamp()
                ? utcFromEpoch(static_cast<std::time_t>(item.timestamp()))
                : fetchedAt;
            std::string importance = "MEDIUM";
            if (item.has_star() && item.star() >= 3) {
                importance = "HIGH";
            }
            const std::string upperTitle = uppercaseAscii(item.title());
            if (upperTitle.find("FOMC") != std::string::npos
                || upperTitle.find("CPI") != std::string::npos
                || upperTitle.find("NONFARM") != std::string::npos
                || upperTitle.find("GDP") != std::string::npos) {
                importance = "CRITICAL";
            }
            auto *event = appendMarketEvent(
                macroEvents,
                "US_MACRO",
                "ECONOMIC_CALENDAR",
                item.title(),
                item.country().empty() ? "Futu 财经日历" : item.country(),
                publishedAt,
                fetchedAt,
                {},
                importance,
                utcAfter(
                    item.has_timestamp()
                        ? static_cast<std::time_t>(item.timestamp())
                        : now,
                    86400
                )
            );
            if (item.has_previous()) setString(event, "previous", item.previous());
            if (item.has_consensus()) setString(event, "consensus", item.consensus());
            if (item.has_actual()) setString(event, "actual", item.actual());
        }
    } else {
        const std::string message = economicResponse.retmsg();
        macroErrors.push_back(
            message == "Unknown protocol ID."
                ? "当前 OpenD 版本不支持美国经济日历"
                : message.empty()
                ? "美国经济日历不可用"
                : message
        );
    }

    Qot_GetFedWatchTargetRate::Request fedRequest;
    fedRequest.mutable_c2s();
    Qot_GetFedWatchTargetRate::Response fedResponse;
    status = sendRequest(
        client,
        FTAPI_ProtoID_Qot_GetFedWatchTargetRate,
        fedRequest,
        &fedResponse
    );
    if (status == ChangFuFutuStatusOk
        && fedResponse.rettype() == Common::RetType_Succeed
        && fedResponse.has_s2c()) {
        fedWatchSucceeded = true;
        for (const auto &meeting : fedResponse.s2c().meetinglist()) {
            std::ostringstream detail;
            bool first = true;
            for (const auto &target : meeting.targetratelist()) {
                if (!first) detail << "；";
                detail << target.targetrange() << " "
                    << std::fixed << std::setprecision(1)
                    << target.probability() << "%";
                first = false;
            }
            auto *event = appendMarketEvent(
                macroEvents,
                "US_MACRO",
                "FEDWATCH",
                "美联储目标利率概率 · " + meeting.meetingdate(),
                "Futu FedWatch",
                meeting.meetingdate() + "T00:00:00Z",
                fetchedAt,
                {},
                "CRITICAL",
                utcAfter(now, 30 * 86400)
            );
            if (!detail.str().empty()) setString(event, "detail", detail.str());
        }
    } else {
        const std::string message = fedResponse.retmsg();
        macroErrors.push_back(
            message == "Unknown protocol ID."
                ? "当前 OpenD 版本不支持 FedWatch"
                : (message.empty() ? "FedWatch 不可用" : message)
        );
    }
    setString(
        macroSection,
        "availability",
        economicSucceeded && fedWatchSucceeded ? "AVAILABLE"
            : (economicSucceeded || fedWatchSucceeded ? "PARTIAL" : "UNAVAILABLE")
    );
    if (!macroErrors.empty()) {
        std::ostringstream message;
        for (std::size_t index = 0; index < macroErrors.size(); ++index) {
            if (index > 0) message << "；";
            message << macroErrors[index];
        }
        setString(macroSection, "message", message.str());
    }

    auto *watchlistSection = appendSection("WATCHLIST");
    auto *watchlistEvents =
        (*watchlistSection->mutable_fields())["events"].mutable_list_value();
    std::set<std::string> watchlistSeen;
    int watchlistRequests = 0;
    int watchlistSuccesses = 0;
    bool watchlistProtocolUnsupported = false;

    Qot_GetEarningsCalendar::Request earningsRequest;
    auto *earningsC2S = earningsRequest.mutable_c2s();
    earningsC2S->set_market(Qot_Common::QotMarket_US_Security);
    earningsC2S->set_begindate(calendarDate(now - 86400));
    earningsC2S->set_enddate(calendarDate(now + 30 * 86400));
    Qot_GetEarningsCalendar::Response earningsResponse;
    ++watchlistRequests;
    status = sendRequest(
        client,
        FTAPI_ProtoID_Qot_GetEarningsCalendar,
        earningsRequest,
        &earningsResponse
    );
    if (status == ChangFuFutuStatusOk
        && earningsResponse.rettype() == Common::RetType_Succeed
        && earningsResponse.has_s2c()) {
        ++watchlistSuccesses;
        const std::set<std::string> symbolFilter(symbols.begin(), symbols.end());
        for (const auto &item : earningsResponse.s2c().itemlist()) {
            const std::string symbol =
                quotePrefix(item.security().market()) + "." + item.security().code();
            if (!symbolFilter.empty() && symbolFilter.count(symbol) == 0) {
                continue;
            }
            const std::string publishedAt = item.has_earningstimestamp()
                ? utcFromEpoch(static_cast<std::time_t>(item.earningstimestamp()))
                : item.earningsdate() + "T00:00:00Z";
            appendMarketEvent(
                watchlistEvents,
                "WATCHLIST",
                "EARNINGS",
                (item.name().empty() ? symbol : item.name()) + " 财报日历",
                "Futu 财报日历",
                publishedAt,
                fetchedAt,
                {symbol},
                "HIGH",
                utcAfter(
                    item.has_earningstimestamp()
                        ? static_cast<std::time_t>(item.earningstimestamp())
                        : now,
                    72 * 3600
                )
            );
        }
    } else if (earningsResponse.retmsg() == "Unknown protocol ID.") {
        watchlistProtocolUnsupported = true;
    }

    for (const auto &symbol : symbols) {
        std::string keyword = symbol;
        const auto separator = keyword.find('.');
        if (separator != std::string::npos) {
            keyword = keyword.substr(separator + 1);
        }
        Qot_GetSearchNews::Request request;
        request.mutable_c2s()->set_keyword(keyword);
        request.mutable_c2s()->set_max_count(8);
        request.mutable_c2s()->set_news_sub_type(Qot_GetSearchNews::NewsSubType_ALL);
        Qot_GetSearchNews::Response response;
        ++watchlistRequests;
        status = sendRequest(
            client,
            FTAPI_ProtoID_Qot_GetSearchNews,
            request,
            &response
        );
        if (status != ChangFuFutuStatusOk
            || response.rettype() != Common::RetType_Succeed
            || !response.has_s2c()) {
            if (response.retmsg() == "Unknown protocol ID.") {
                watchlistProtocolUnsupported = true;
            }
            continue;
        }
        ++watchlistSuccesses;
        for (const auto &news : response.s2c().search_news_list()) {
            const std::string dedupe =
                news.url().empty() ? news.title() + "|" + news.publish_time() : news.url();
            if (!watchlistSeen.insert(dedupe).second) continue;
            std::string category = "NEWS";
            std::string importance = "MEDIUM";
            int ttl = 24 * 3600;
            if (news.news_sub_type() == Qot_GetSearchNews::NewsSubType_NOTICE) {
                category = "FILING";
                importance = "HIGH";
                ttl = 72 * 3600;
            } else if (news.news_sub_type() == Qot_GetSearchNews::NewsSubType_RATING) {
                category = "RATING";
                importance = "HIGH";
                ttl = 72 * 3600;
            }
            std::vector<std::string> related;
            for (const auto &value : news.related_securities()) related.push_back(value);
            if (related.empty()) related.push_back(symbol);
            appendMarketEvent(
                watchlistEvents,
                "WATCHLIST",
                category,
                news.title(),
                news.source(),
                news.publish_time().empty() ? fetchedAt : news.publish_time(),
                fetchedAt,
                related,
                importance,
                utcAfter(now, ttl),
                news.url()
            );
        }
    }
    setString(
        watchlistSection,
        "availability",
        watchlistSuccesses == watchlistRequests ? "AVAILABLE"
            : (watchlistSuccesses > 0 ? "PARTIAL" : "UNAVAILABLE")
    );
    if (symbols.empty()) {
        setString(watchlistSection, "message", "当前 Futu 标的池为空");
    } else if (watchlistSuccesses < watchlistRequests) {
        setString(
            watchlistSection,
            "message",
            watchlistProtocolUnsupported
                ? "当前 OpenD 版本不支持财报日历或新闻搜索"
                : "部分标的事件接口不可用"
        );
    }

    auto *riskSection = appendSection("BREAKING_RISK");
    auto *riskEvents = (*riskSection->mutable_fields())["events"].mutable_list_value();
    const std::pair<const char *, const char *> riskQueries[] = {
        {"semiconductor export control", "TRADE_SANCTION"},
        {"chip tariff sanction", "TRADE_SANCTION"},
        {"AI chip export ban", "TRADE_SANCTION"},
        {"Taiwan semiconductor disruption", "GEOPOLITICAL_CONFLICT"},
        {"semiconductor supply chain disruption", "SUPPLY_CHAIN"},
        {"data center cloud cyberattack outage", "SUPPLY_CHAIN"}
    };
    const int riskQueryCount =
        static_cast<int>(sizeof(riskQueries) / sizeof(riskQueries[0]));
    std::set<std::string> riskSeen;
    int riskSuccesses = 0;
    bool riskProtocolUnsupported = false;
    for (const auto &query : riskQueries) {
        Qot_GetSearchNews::Request request;
        request.mutable_c2s()->set_keyword(query.first);
        request.mutable_c2s()->set_max_count(8);
        request.mutable_c2s()->set_news_sub_type(Qot_GetSearchNews::NewsSubType_NEWS);
        Qot_GetSearchNews::Response response;
        status = sendRequest(
            client,
            FTAPI_ProtoID_Qot_GetSearchNews,
            request,
            &response
        );
        if (status != ChangFuFutuStatusOk
            || response.rettype() != Common::RetType_Succeed
            || !response.has_s2c()) {
            if (response.retmsg() == "Unknown protocol ID.") {
                riskProtocolUnsupported = true;
            }
            continue;
        }
        ++riskSuccesses;
        for (const auto &news : response.s2c().search_news_list()) {
            const std::string dedupe =
                news.url().empty() ? news.title() + "|" + news.publish_time() : news.url();
            if (!riskSeen.insert(dedupe).second) continue;
            std::vector<std::string> related;
            for (const auto &value : news.related_securities()) related.push_back(value);
            appendMarketEvent(
                riskEvents,
                "BREAKING_RISK",
                query.second,
                news.title(),
                news.source(),
                news.publish_time().empty() ? fetchedAt : news.publish_time(),
                fetchedAt,
                related,
                "CRITICAL",
                utcAfter(now, 12 * 3600),
                news.url()
            );
        }
    }
    setString(
        riskSection,
        "availability",
        riskSuccesses == riskQueryCount ? "AVAILABLE"
            : (riskSuccesses > 0 ? "PARTIAL" : "UNAVAILABLE")
    );
    if (riskSuccesses < riskQueryCount) {
        setString(
            riskSection,
            "message",
            riskProtocolUnsupported
                ? "当前 OpenD 版本不支持新闻搜索"
                : "部分突发风险检索不可用"
        );
    }
    return writeJson(client, root, "市场情报", json);
#else
    client->lastError = "未配置 Futu C++ SDK";
    return ChangFuFutuStatusSdkUnavailable;
#endif
}

ChangFuFutuStatus changfu_futu_trade_readiness_json(
    ChangFuFutuClient *client,
    const char *accountId,
    const char *symbol,
    const char *side,
    const char *positionEffect,
    const char *orderType,
    const char *tradingSession,
    const char *timeInForce,
    double quantity,
    double limitPrice,
    char **json
) {
    if (client == nullptr || accountId == nullptr || symbol == nullptr || side == nullptr
        || positionEffect == nullptr || orderType == nullptr || tradingSession == nullptr
        || timeInForce == nullptr || json == nullptr) {
        return ChangFuFutuStatusInvalidArgument;
    }
    *json = nullptr;
#if defined(CHANGFU_FUTU_SDK_AVAILABLE)
    if (!changfu_futu_is_connected(client)) {
        setError(client, "OpenD 尚未连接");
        return ChangFuFutuStatusConnectionFailed;
    }
    Qot_Common::Security security;
    std::string canonicalSymbol;
    int tradeMarket = 0;
    int securityMarket = 0;
    int tradeSide = 0;
    if (!configureTrade(
        client,
        symbol,
        side,
        positionEffect,
        orderType,
        tradingSession,
        timeInForce,
        quantity,
        limitPrice,
        &security,
        &canonicalSymbol,
        &tradeMarket,
        &securityMarket,
        &tradeSide
    )) {
        return ChangFuFutuStatusInvalidArgument;
    }
    ChangFuFutuAccount account;
    ChangFuFutuStatus status =
        selectTradeAccount(client, accountId, tradeMarket, &account);
    if (status != ChangFuFutuStatusOk) return status;

    Trd_Common::Funds funds;
    status = loadFunds(
        client,
        account,
        tradeMarket,
        currencyForMarket(tradeMarket),
        true,
        &funds
    );
    if (status != ChangFuFutuStatusOk) return status;

    Trd_GetMaxTrdQtys::Request maxRequest;
    auto *maxC2S = maxRequest.mutable_c2s();
    auto *maxHeader = maxC2S->mutable_header();
    maxHeader->set_trdenv(account.environment);
    maxHeader->set_accid(account.id);
    maxHeader->set_trdmarket(tradeMarket);
    maxC2S->set_ordertype(Trd_Common::OrderType_Normal);
    maxC2S->set_code(security.code());
    maxC2S->set_price(limitPrice);
    maxC2S->set_secmarket(securityMarket);
    maxC2S->set_session(Common::Session_RTH);
    Trd_GetMaxTrdQtys::Response maxResponse;
    status = sendRequest(
        client,
        FTAPI_ProtoID_Trd_GetMaxTrdQtys,
        maxRequest,
        &maxResponse
    );
    if (status != ChangFuFutuStatusOk) return status;
    if (maxResponse.rettype() != Common::RetType_Succeed
        || !maxResponse.has_s2c()
        || !maxResponse.s2c().has_maxtrdqtys()) {
        setBrokerResponseError(
            client,
            maxResponse.has_errcode() ? maxResponse.errcode() : 0,
            maxResponse.has_retmsg() ? maxResponse.retmsg() : "最大可交易数量不可用"
        );
        return ChangFuFutuStatusOperationFailed;
    }

    const auto &maximums = maxResponse.s2c().maxtrdqtys();
    const std::string effect(positionEffect);
    double maximum = 0;
    bool shortable = false;
    std::string reason;
    const bool marginAccount =
        account.accountType == Trd_Common::TrdAccType_Margin;
    const bool marginCallActive =
        (funds.has_margincallmargin() && funds.margincallmargin() > 0)
        || (funds.has_risklevel()
            && funds.risklevel() == Trd_Common::CltRiskLevel_Danger);
    if (effect == "OPEN_LONG" || effect == "ADD_LONG") {
        maximum = marginAccount && maximums.has_maxcashandmarginbuy()
            ? maximums.maxcashandmarginbuy()
            : maximums.maxcashbuy();
    } else if (effect == "REDUCE_LONG") {
        maximum = maximums.maxpositionsell();
    } else if (effect == "COVER_SHORT") {
        maximum = maximums.has_maxbuyback() ? maximums.maxbuyback() : 0;
    } else if (effect == "OPEN_SHORT" || effect == "ADD_SHORT") {
        maximum = maximums.has_maxsellshort() ? maximums.maxsellshort() : 0;
        shortable = maximum >= quantity;
        if (!marginAccount) {
            reason = "Futu 当前账户不是保证金账户";
        } else if (marginCallActive) {
            reason = "Futu 账户处于保证金追缴或高风险状态";
        } else if (!maximums.has_maxsellshort() || !maximums.has_shortrequiredim()
            || maximums.shortrequiredim() <= 0 || !shortable) {
            reason = "Futu 无法确认该标的券源、卖空额度或初始保证金";
        }
    }
    if (reason.empty() && maximum < quantity) {
        reason = "Futu 最大可交易数量不足";
    }

    google::protobuf::Struct root;
    setString(&root, "provider", "FUTU");
    setString(&root, "accountId", std::to_string(account.id));
    setString(&root, "environment", "REAL");
    setBool(&root, "ready", reason.empty());
    if (!reason.empty()) setString(&root, "reason", reason);
    setBool(&root, "marginAccount", marginAccount);
    setBool(&root, "marginCallActive", marginCallActive);
    if (effect == "OPEN_SHORT" || effect == "ADD_SHORT") {
        setBool(&root, "shortable", shortable);
    }
    setNumber(&root, "maxOrderQuantity", maximum);
    setString(&root, "checkedAt", utcNow());
    return writeJson(client, root, "交易就绪检查", json);
#else
    client->lastError = "未配置 Futu C++ SDK";
    return ChangFuFutuStatusSdkUnavailable;
#endif
}

ChangFuFutuStatus changfu_futu_place_order_json(
    ChangFuFutuClient *client,
    const char *intentId,
    const char *accountId,
    const char *symbol,
    const char *side,
    const char *positionEffect,
    const char *orderType,
    const char *tradingSession,
    const char *timeInForce,
    double quantity,
    double limitPrice,
    char **json
) {
    if (client == nullptr || intentId == nullptr || accountId == nullptr
        || symbol == nullptr || side == nullptr || positionEffect == nullptr
        || orderType == nullptr || tradingSession == nullptr || timeInForce == nullptr
        || json == nullptr) {
        return ChangFuFutuStatusInvalidArgument;
    }
    *json = nullptr;
#if defined(CHANGFU_FUTU_SDK_AVAILABLE)
    if (!changfu_futu_is_connected(client)) {
        setError(client, "OpenD 尚未连接");
        return ChangFuFutuStatusConnectionFailed;
    }
    const std::string remark = "cf:" + std::string(intentId);
    if (remark.size() > 64) {
        setError(client, "Futu 订单 intent ID 超过 remark 长度限制");
        return ChangFuFutuStatusInvalidArgument;
    }
    Qot_Common::Security security;
    std::string canonicalSymbol;
    int tradeMarket = 0;
    int securityMarket = 0;
    int tradeSide = 0;
    if (!configureTrade(
        client,
        symbol,
        side,
        positionEffect,
        orderType,
        tradingSession,
        timeInForce,
        quantity,
        limitPrice,
        &security,
        &canonicalSymbol,
        &tradeMarket,
        &securityMarket,
        &tradeSide
    )) {
        return ChangFuFutuStatusInvalidArgument;
    }
    ChangFuFutuAccount account;
    ChangFuFutuStatus status =
        selectTradeAccount(client, accountId, tradeMarket, &account);
    if (status != ChangFuFutuStatusOk) return status;

    char *readinessJson = nullptr;
    status = changfu_futu_trade_readiness_json(
        client,
        accountId,
        symbol,
        side,
        positionEffect,
        orderType,
        tradingSession,
        timeInForce,
        quantity,
        limitPrice,
        &readinessJson
    );
    if (status != ChangFuFutuStatusOk) return status;
    google::protobuf::Struct readiness;
    const auto readinessStatus = google::protobuf::util::JsonStringToMessage(
        readinessJson == nullptr ? "" : readinessJson,
        &readiness
    );
    if (readinessJson != nullptr) std::free(readinessJson);
    const auto ready = readiness.fields().find("ready");
    if (!readinessStatus.ok() || ready == readiness.fields().end()
        || !ready->second.bool_value()) {
        const auto reason = readiness.fields().find("reason");
        setError(
            client,
            reason == readiness.fields().end()
                ? "Futu 本地真实交易复核未通过"
                : reason->second.string_value()
        );
        return ChangFuFutuStatusOperationFailed;
    }

    Trd_PlaceOrder::Request request;
    auto *c2s = request.mutable_c2s();
    if (!configurePacketID(client, c2s->mutable_packetid())) {
        return ChangFuFutuStatusConnectionFailed;
    }
    auto *header = c2s->mutable_header();
    header->set_trdenv(account.environment);
    header->set_accid(account.id);
    header->set_trdmarket(tradeMarket);
    c2s->set_trdside(tradeSide);
    c2s->set_ordertype(Trd_Common::OrderType_Normal);
    c2s->set_code(security.code());
    c2s->set_qty(quantity);
    c2s->set_price(limitPrice);
    c2s->set_secmarket(securityMarket);
    c2s->set_remark(remark);
    c2s->set_timeinforce(Trd_Common::TimeInForce_DAY);
    c2s->set_filloutsiderth(false);
    c2s->set_session(Common::Session_RTH);
    Trd_PlaceOrder::Response response;
    status = sendRequest(client, FTAPI_ProtoID_Trd_PlaceOrder, request, &response);
    if (status != ChangFuFutuStatusOk) return status;
    if (response.rettype() != Common::RetType_Succeed || !response.has_s2c()) {
        setBrokerResponseError(
            client,
            response.has_errcode() ? response.errcode() : 0,
            response.has_retmsg() ? response.retmsg() : "提交订单失败"
        );
        return ChangFuFutuStatusOperationFailed;
    }
    const auto &result = response.s2c();
    google::protobuf::Struct root;
    setString(
        &root,
        "brokerOrderId",
        result.has_orderidex() && !result.orderidex().empty()
            ? result.orderidex()
            : std::to_string(result.orderid())
    );
    setString(&root, "status", "SUBMITTED");
    setNumber(&root, "submittedQuantity", quantity);
    setNumber(&root, "filledQuantity", 0);
    setString(&root, "remark", remark);
    setString(&root, "updatedAt", utcNow());
    return writeJson(client, root, "提交订单", json);
#else
    client->lastError = "未配置 Futu C++ SDK";
    return ChangFuFutuStatusSdkUnavailable;
#endif
}

ChangFuFutuStatus changfu_futu_find_order_by_intent_json(
    ChangFuFutuClient *client,
    const char *intentId,
    const char *accountId,
    const char *symbol,
    const char *side,
    double quantity,
    double limitPrice,
    char **json
) {
    if (client == nullptr || intentId == nullptr || accountId == nullptr
        || symbol == nullptr || side == nullptr || json == nullptr) {
        return ChangFuFutuStatusInvalidArgument;
    }
    *json = nullptr;
#if defined(CHANGFU_FUTU_SDK_AVAILABLE)
    Qot_Common::Security security;
    std::string canonicalSymbol;
    if (!parseProviderSymbol(symbol, &security, &canonicalSymbol)) {
        setError(client, "Futu 订单标的格式无效");
        return ChangFuFutuStatusInvalidArgument;
    }
    int tradeMarket = 0;
    int securityMarket = 0;
    if (!tradeMarketForSecurity(security, &tradeMarket, &securityMarket)) {
        setError(client, "Futu 订单市场不受支持");
        return ChangFuFutuStatusInvalidArgument;
    }
    ChangFuFutuAccount account;
    ChangFuFutuStatus status =
        selectTradeAccount(client, accountId, tradeMarket, &account);
    if (status != ChangFuFutuStatusOk) return status;
    std::vector<Trd_Common::Order> orders;
    status = loadManagedOrders(client, account, tradeMarket, &orders);
    if (status != ChangFuFutuStatusOk) return status;
    const std::string remark = "cf:" + std::string(intentId);
    const int expectedSide = std::string(side) == "BUY"
        ? Trd_Common::TrdSide_Buy
        : Trd_Common::TrdSide_Sell;
    std::vector<Trd_Common::Order> matches;
    for (const auto &order : orders) {
        if (sameOrderIdentity(
            order,
            remark,
            security.code(),
            expectedSide,
            quantity,
            limitPrice
        )) {
            matches.push_back(order);
        }
    }
    if (matches.size() > 1) {
        setError(client, "按订单意图查到多笔 Futu 订单，已停止自动处理");
        return ChangFuFutuStatusOperationFailed;
    }
    if (matches.empty()) {
        const char literal[] = "null";
        char *buffer = static_cast<char *>(std::malloc(sizeof(literal)));
        if (buffer == nullptr) {
            setError(client, "Futu 查单结果内存分配失败");
            return ChangFuFutuStatusOperationFailed;
        }
        std::memcpy(buffer, literal, sizeof(literal));
        *json = buffer;
        setError(client, "");
        return ChangFuFutuStatusOk;
    }
    google::protobuf::Struct root;
    writeOrderReceipt(&root, matches.front(), remark);
    return writeJson(client, root, "订单意图查单", json);
#else
    client->lastError = "未配置 Futu C++ SDK";
    return ChangFuFutuStatusSdkUnavailable;
#endif
}

ChangFuFutuStatus changfu_futu_cancel_order_json(
    ChangFuFutuClient *client,
    const char *intentId,
    const char *accountId,
    const char *brokerOrderId,
    const char *symbol,
    char **json
) {
    if (client == nullptr || intentId == nullptr || accountId == nullptr
        || brokerOrderId == nullptr || symbol == nullptr || json == nullptr) {
        return ChangFuFutuStatusInvalidArgument;
    }
    *json = nullptr;
#if defined(CHANGFU_FUTU_SDK_AVAILABLE)
    Qot_Common::Security security;
    std::string canonicalSymbol;
    if (!parseProviderSymbol(symbol, &security, &canonicalSymbol)) {
        setError(client, "Futu 撤单标的格式无效");
        return ChangFuFutuStatusInvalidArgument;
    }
    int tradeMarket = 0;
    int securityMarket = 0;
    if (!tradeMarketForSecurity(security, &tradeMarket, &securityMarket)) {
        setError(client, "Futu 撤单市场不受支持");
        return ChangFuFutuStatusInvalidArgument;
    }
    ChangFuFutuAccount account;
    ChangFuFutuStatus status =
        selectTradeAccount(client, accountId, tradeMarket, &account);
    if (status != ChangFuFutuStatusOk) return status;
    std::vector<Trd_Common::Order> orders;
    status = loadManagedOrders(client, account, tradeMarket, &orders);
    if (status != ChangFuFutuStatusOk) return status;
    const std::string expectedRemark = "cf:" + std::string(intentId);
    const std::string expectedOrderID(brokerOrderId);
    const Trd_Common::Order *target = nullptr;
    for (const auto &order : orders) {
        const std::string currentID =
            order.has_orderidex() && !order.orderidex().empty()
                ? order.orderidex()
                : std::to_string(order.orderid());
        if (currentID == expectedOrderID) {
            target = &order;
            break;
        }
    }
    if (target == nullptr || !target->has_remark() || target->remark() != expectedRemark
        || uppercaseAscii(target->code()) != uppercaseAscii(security.code())) {
        setError(client, "拒绝撤销不属于当前系统意图的 Futu 订单");
        return ChangFuFutuStatusOperationFailed;
    }
    const std::string currentStatus = normalizedFutuOrderStatus(target->orderstatus());
    if (currentStatus == "FILLED" || currentStatus == "CANCELLED"
        || currentStatus == "PARTIAL_CANCELLED" || currentStatus == "REJECTED") {
        google::protobuf::Struct root;
        writeOrderReceipt(&root, *target, expectedRemark);
        return writeJson(client, root, "撤单终态查询", json);
    }

    Trd_ModifyOrder::Request request;
    auto *c2s = request.mutable_c2s();
    if (!configurePacketID(client, c2s->mutable_packetid())) {
        return ChangFuFutuStatusConnectionFailed;
    }
    auto *header = c2s->mutable_header();
    header->set_trdenv(account.environment);
    header->set_accid(account.id);
    header->set_trdmarket(tradeMarket);
    c2s->set_modifyorderop(Trd_Common::ModifyOrderOp_Cancel);
    c2s->set_forall(false);
    if (target->has_orderidex() && !target->orderidex().empty()) {
        c2s->set_orderid(0);
        c2s->set_orderidex(target->orderidex());
    } else {
        c2s->set_orderid(target->orderid());
    }
    Trd_ModifyOrder::Response response;
    status = sendRequest(client, FTAPI_ProtoID_Trd_ModifyOrder, request, &response);
    if (status != ChangFuFutuStatusOk) return status;
    if (response.rettype() != Common::RetType_Succeed || !response.has_s2c()) {
        setBrokerResponseError(
            client,
            response.has_errcode() ? response.errcode() : 0,
            response.has_retmsg() ? response.retmsg() : "撤销订单失败"
        );
        return ChangFuFutuStatusOperationFailed;
    }
    google::protobuf::Struct root;
    setString(&root, "brokerOrderId", expectedOrderID);
    setString(&root, "status", "CANCEL_PENDING");
    setNumber(&root, "submittedQuantity", target->qty());
    setNumber(&root, "filledQuantity", target->has_fillqty() ? target->fillqty() : 0);
    if (target->has_fillavgprice()) {
        setNumber(&root, "filledAveragePrice", target->fillavgprice());
    }
    setString(&root, "remark", expectedRemark);
    setString(&root, "updatedAt", utcNow());
    return writeJson(client, root, "撤销订单", json);
#else
    client->lastError = "未配置 Futu C++ SDK";
    return ChangFuFutuStatusSdkUnavailable;
#endif
}

void changfu_futu_free_string(char *value) {
    std::free(value);
}

const char *changfu_futu_last_error(const ChangFuFutuClient *client) {
    if (client == nullptr) {
        return "Futu 客户端为空";
    }
    return client->lastError.c_str();
}
