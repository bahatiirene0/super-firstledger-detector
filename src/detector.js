const { Client } = require("xrpl");
const sqlite3 = require("sqlite3");
const logger = require("./logger");
const PerformanceTracker = require("./performance");

class SuperFirstLedgerDetector {
  constructor() {
    this.nodes = ["wss://s1.ripple.com", "wss://s2.ripple.com", "wss://xrpl.ws"];
    this.burnAmounts = ["100000000", "400000000", "1000000000"];
    this.burnAddress = "rBurnFirstledger";
    this.db = new sqlite3.Database("./db/ledger.db", (err) => {
      if (err) logger.error(`Failed to initialize ledger DB: ${err.message}`);
    });
    this.clients = [];
    this.tokens = new Map();
    this.lastLedger = 0;
    this.performance = new PerformanceTracker();
    this.dbQueue = [];

    this.initDb();
  }

  initDb() {
    this.db.serialize(() => {
      this.db.run(
        "CREATE TABLE IF NOT EXISTS ledgers (ledger_index INTEGER PRIMARY KEY, processed INTEGER)",
        (err) => {
          if (err) logger.error(`Failed to create ledgers table: ${err.message}`);
        }
      );

      this.db.get("SELECT COUNT(*) as count FROM ledgers", (err, row) => {
        if (err) {
          logger.error(`Failed to check ledgers count: ${err.message}`);
          return;
        }
        if (row && row.count === 0) {
          const mockLedgers = [
            [94300000, 1], // Closer to current ledger (~94M in Feb 2025)
            [94300001, 1],
            [94300002, 1],
            [94300003, 1],
            [94300004, 1],
            [94300005, 1],
          ];
          const stmt = this.db.prepare(
            "INSERT INTO ledgers (ledger_index, processed) VALUES (?, ?)"
          );
          mockLedgers.forEach((data) => stmt.run(data));
          stmt.finalize(() => logger.info("Inserted mock ledger data"));
        }
      });
    });
  }

  async start(sendUpdate) {
    this.sendUpdate = sendUpdate;
    await this.connectAllNodes();
    await this.catchUpMissedLedgers();
    this.listenForBurnsAndUpdates();
  }

  async connectAllNodes() {
    for (const node of this.nodes) {
      await this.connectNode(node, 3, 10000); // 10-second timeout
    }
    if (!this.clients.length) {
      logger.error("No nodes connected after retries, exiting...");
      process.exit(1);
    }
  }

  async connectNode(node, retries, timeout = 10000) {
    const startTime = Date.now();
    for (let i = 0; i < retries; i++) {
      try {
        const client = new Client(node, { connectionTimeout: timeout });
        await client.connect();
        this.clients.push(client);
        logger.info(`Connected to ${node}`);
        this.performance.track("NodeConnect", startTime, node);
        this.lastLedger = Math.max(
          this.lastLedger,
          (await client.request({ command: "ledger_current" })).result.ledger_current_index - 1
        );
        return;
      } catch (e) {
        logger.warn(`Attempt ${i + 1}/${retries} failed for ${node}: ${e.message}`);
        if (i === retries - 1) {
          this.performance.track("NodeConnect", startTime, node, false);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, i)));
      }
    }
  }

  async catchUpMissedLedgers() {
    try {
      const lastProcessed = await new Promise((resolve) =>
        this.db.get(
          "SELECT MAX(ledger_index) as last FROM ledgers WHERE processed = 1",
          (err, row) => resolve(err ? 94300000 : row && row.last ? row.last : 94300000) // Default to mock base
        )
      );
      // Limit catch-up to last 1000 ledgers to avoid overloading
      const catchUpStart = Math.max(lastProcessed + 1, this.lastLedger - 1000);
      if (this.lastLedger <= lastProcessed || catchUpStart >= this.lastLedger) return;

      const client = this.clients[0];
      logger.info(`Catching up from ledger ${catchUpStart} to ${this.lastLedger}`);
      for (let i = catchUpStart; i <= this.lastLedger; i++) {
        try {
          const ledger = await client.request({ command: "ledger", ledger_index: i });
          if (ledger.result.ledger && Array.isArray(ledger.result.ledger.transactions)) {
            ledger.result.ledger.transactions.forEach((tx) => this.checkBurn(tx));
          } else {
            logger.debug(`Ledger ${i} has no transactions`);
          }
          this.markLedgerProcessed(i);
        } catch (e) {
          logger.warn(`Failed to process ledger ${i}: ${e.message}`);
          if (e.message.includes("ledgerNotFound")) break; // Stop on old ledger errors
        }
      }
    } catch (e) {
      logger.error(`Catch-up failed: ${e.message}`);
    }
  }

  listenForBurnsAndUpdates() {
    this.clients.forEach((client) => {
      client.on("transaction", (tx) => {
        try {
          this.lastLedger = tx.ledger_index;
          this.checkBurn(tx.transaction);
          this.checkPoolUpdate(tx.transaction);
          this.markLedgerProcessed(tx.ledger_index);
        } catch (e) {
          logger.error(`Transaction processing error: ${e.message}`);
        }
      });

      client.on("disconnected", async () => {
        logger.warn(`Disconnected from ${client.connection.url}, reconnecting...`);
        this.clients = this.clients.filter((c) => c !== client);
        await this.connectNode(client.connection.url, 3);
        await this.catchUpMissedLedgers();
      });

      client.request({ command: "subscribe", streams: ["transactions"] }).catch((e) =>
        logger.error(`Subscription failed for ${client.connection.url}: ${e.message}`)
      );
    });
  }

  checkBurn(tx) {
    try {
      if (
        tx.TransactionType === "Payment" &&
        this.burnAmounts.includes(tx.Amount) &&
        tx.meta?.TransactionResult === "tesSUCCESS"
      ) {
        const startTime = Date.now();
        const burnedXRP = parseInt(tx.Amount) / 1_000_000;
        const isFirstLedger = tx.Destination === this.burnAddress;
        logger.info(
          `Burn detected: ${burnedXRP} XRP to ${tx.Destination} (${isFirstLedger ? "FirstLedger" : "Unsure"})`
        );
        this.fetchInitialTokenInfo(tx.Account, burnedXRP, isFirstLedger, startTime, this.clients[0].connection.url);
      }
    } catch (e) {
      logger.error(`Burn check failed: ${e.message}`);
    }
  }

  async fetchInitialTokenInfo(account, burnedXRP, isFirstLedger, startTime, node) {
    const client = this.clients[0];
    const tokenInfo = {
      burnedXRP,
      creator: account,
      isFirstLedger,
      timestamp: new Date().toISOString(),
    };

    try {
      const txs = await this.retryRequest(client, { command: "account_tx", account, limit: 10 });
      for (const tx of txs.result.transactions) {
        if (tx.tx.TransactionType === "AMMCreate") {
          tokenInfo.currency = tx.tx.Asset?.currency || tx.tx.Asset2?.currency || "Unknown";
          tokenInfo.issuer = tx.tx.Asset?.issuer || tx.tx.Asset2?.issuer || "Unknown";
          tokenInfo.ammAccount =
            tx.meta.AffectedNodes.find((n) => n.CreatedNode?.LedgerEntryType === "AMM")?.CreatedNode
              ?.NewFields.Account || "Unknown";
          break;
        }
      }

      const lines = await this.retryRequest(client, {
        command: "account_lines",
        account: tokenInfo.issuer,
      });
      tokenInfo.holders = lines.result.lines?.length || 0;
      tokenInfo.supply =
        lines.result.lines?.reduce((sum, line) => sum + parseFloat(line.balance || 0), 0) || 0;

      await this.updatePoolData(tokenInfo);
      this.tokens.set(`${tokenInfo.currency}-${tokenInfo.issuer}`, tokenInfo);
      this.sendUpdate(tokenInfo);
      this.performance.track("InitialDetection", startTime, node);
    } catch (e) {
      logger.error(`Failed to fetch token info for ${account}: ${e.message}`);
      this.performance.track("InitialDetection", startTime, node, false);
    }
  }

  checkPoolUpdate(tx) {
    try {
      const key = `${tx.Asset?.currency}-${tx.Asset?.issuer}` || `${tx.Asset2?.currency}-${tx.Asset2?.issuer}`;
      const token = this.tokens.get(key);
      if (
        token &&
        (tx.TransactionType === "AMMDeposit" || tx.TransactionType === "AMMWithdraw" || tx.TransactionType === "Payment") &&
        (tx.Account === token.ammAccount || tx.Destination === token.ammAccount)
      ) {
        const startTime = Date.now();
        this.updatePoolData(token, startTime, this.clients[0].connection.url);
      }
    } catch (e) {
      logger.error(`Pool update check failed: ${e.message}`);
    }
  }

  async updatePoolData(token, startTime, node) {
    const client = this.clients[0];
    try {
      const pool = await this.retryRequest(client, { command: "amm_info", amm_account: token.ammAccount });
      token.liquidityXRP = parseInt(pool.result.amm?.amount || 0) / 1_000_000;
      token.liquidityTokens = parseInt(pool.result.amm?.amount2 || 0);
      token.price = token.liquidityTokens ? token.liquidityXRP / token.liquidityTokens : 0;
      token.marketCap = token.supply * token.price;
      token.holders = (await this.retryRequest(client, { command: "account_lines", account: token.issuer }))
        .result.lines?.length || 0;
      this.sendUpdate(token);
      if (startTime) this.performance.track("MarketUpdate", startTime, node);
    } catch (e) {
      logger.warn(`Pool update failed for ${token.currency}: ${e.message}`);
      if (startTime) this.performance.track("MarketUpdate", startTime, node, false);
    }
  }

  async retryRequest(client, request, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        return await client.request(request);
      } catch (e) {
        logger.warn(`Request failed (attempt ${i + 1}/${retries}): ${e.message}`);
        if (i === retries - 1) throw e;
        await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, i)));
      }
    }
  }

  markLedgerProcessed(index) {
    this.db.run(
      "INSERT OR REPLACE INTO ledgers (ledger_index, processed) VALUES (?, 1)",
      [index],
      (err) => {
        if (err) {
          logger.warn(`Ledger DB write failed, queuing: ${err.message}`);
          this.dbQueue.push(index);
        }
      }
    );
  }

  getPerformanceStats() {
    return this.performance.getStats();
  }
}

module.exports = SuperFirstLedgerDetector;