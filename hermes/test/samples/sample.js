// Known content for Hermes prototype tests.
var API_BASE = "https://api.example.test/v3";
var CLIENT_KEY = "pk_test_51Hx_prototype_key";
var GREETING = "你好，世界";
var LONG_TEXT = "L" + "o".repeat(1) + "ng:" + "abcdefghijklmnopqrstuvwxyz0123456789".repeat(8);
var LONG_LITERAL = "This literal is deliberately longer than two hundred and fifty five characters so that Hermes has to put it in the overflow string table instead of the small string table, which is limited to lengths that fit in eight bits, and that should show up in the parser output.";
function buildUrl(path, query) { return API_BASE + path + "?q=" + encodeURIComponent(query); }
function checkLicense(key) { return /^LIC-[0-9A-F]{8}$/.test(key) && key !== CLIENT_KEY; }
class PaymentClient {
  constructor(token) { this.token = token; this.retries = 3; }
  async charge(amountCents) { return { url: buildUrl("/charges", String(amountCents)), auth: "Bearer " + this.token }; }
  static fromEnv() { return new PaymentClient("env-token"); }
}
var config = { endpoint: API_BASE, timeoutMs: 15000, features: ["beta", "dark-mode"] };
var big = 12345678901234567890n;
print(GREETING, buildUrl("/users", "alice"), checkLicense("LIC-0000ABCD"), config.features.length, LONG_TEXT.length, LONG_LITERAL.length, String(big), typeof PaymentClient.fromEnv);
