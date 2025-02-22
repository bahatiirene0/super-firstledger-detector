const sqlite3 = require("sqlite3"); // Direct import, verbose() is optional
const logger = require("./logger");

class PerformanceTracker {
  constructor() {
    this.db = new sqlite3.Database("./db/performance.db", (err) => {
      if (err) logger.error(`Failed to initialize performance DB: ${err.message}`);
    });
    this.dbQueue = [];
    this.initDb();
    this.statsInterval = setInterval(() => this.logStats().catch(() => {}), 300000);
  }

  initDb() {
    this.db.serialize(() => {
      this.db.run(
        `
        CREATE TABLE IF NOT EXISTS metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event TEXT,
          timestamp INTEGER,
          latency REAL,
          node TEXT,
          success INTEGER
        )
      `,
      (err) => {
        if (err) logger.error(`Failed to create metrics table: ${err.message}`);
      }
      );

      // Insert mock data if empty
      this.db.get("SELECT COUNT(*) as count FROM metrics", (err, row) => {
        if (err) {
          logger.error(`Failed to check metrics count: ${err.message}`);
          return;
        }
        if (row.count === 0) {
          const now = Date.now();
          const mockData = [
            ["InitialDetection", now - 240000, 0.45, "wss://s1.ripple.com", 1],
            ["InitialDetection", now - 180000, 0.60, "wss://s2.ripple.com", 1],
            ["MarketUpdate", now - 120000, 0.30, "wss://s1.ripple.com", 1],
            ["MarketUpdate", now - 60000, 0.80, "wss://s2.ripple.com", 0],
            ["NodeConnect", now - 300000, 0.90, "wss://xrpl.ws", 1],
          ];
          const stmt = this.db.prepare(
            "INSERT INTO metrics (event, timestamp, latency, node, success) VALUES (?, ?, ?, ?, ?)"
          );
          mockData.forEach((data) => stmt.run(data));
          stmt.finalize(() => logger.info("Inserted mock performance data"));
        }
      });
    });
  }

  track(event, startTime, node, success = true) {
    const latency = (Date.now() - startTime) / 1000;
    const data = [event, Date.now(), latency, node, success ? 1 : 0];
    this.db.run(
      "INSERT INTO metrics (event, timestamp, latency, node, success) VALUES (?, ?, ?, ?, ?)",
      data,
      (err) => {
        if (err) {
          logger.warn(`DB write failed, queuing: ${err.message}`);
          this.dbQueue.push(data);
        } else {
          logger.info(`${event} - Latency: ${latency.toFixed(3)}s, Node: ${node}, Success: ${success}`);
        }
      }
    );
  }

  async logStats() {
    try {
      const now = Date.now();
      const fiveMinAgo = now - 300000;

      const summary = await new Promise((resolve, reject) =>
        this.db.all(
          `
          SELECT 
            event,
            COUNT(*) as count,
            AVG(latency) as avgLatency,
            MIN(latency) as minLatency,
            MAX(latency) as maxLatency,
            SUM(success) as successes,
            COUNT(*) - SUM(success) as failures
          FROM metrics
          WHERE timestamp >= ?
          GROUP BY event
          `,
          [fiveMinAgo],
          (err, rows) => (err ? reject(err) : resolve(rows))
        )
      );

      logger.info("Performance Stats (Last 5 Minutes):");
      summary.forEach((row) => {
        const successRate = (row.successes / row.count) * 100;
        logger.info(
          `${row.event}: Count=${row.count}, Avg Latency=${row.avgLatency.toFixed(3)}s, ` +
          `Min=${row.minLatency.toFixed(3)}s, Max=${row.maxLatency.toFixed(3)}s, ` +
          `Success Rate=${successRate.toFixed(1)}%`
        );
      });
    } catch (e) {
      logger.error(`Failed to log stats: ${e.message}`);
    }
  }

  async getStats() {
    try {
      const fiveMinAgo = Date.now() - 300000;
      return await new Promise((resolve, reject) =>
        this.db.all(
          `
          SELECT 
            event,
            COUNT(*) as count,
            AVG(latency) as avgLatency,
            MIN(latency) as minLatency,
            MAX(latency) as maxLatency,
            SUM(success) / COUNT(*) * 100 as successRate
          FROM metrics
          WHERE timestamp >= ?
          GROUP BY event
          `,
          [fiveMinAgo],
          (err, rows) => (err ? reject(err) : resolve(rows))
        )
      );
    } catch (e) {
      logger.error(`Failed to get stats: ${e.message}`);
      return [];
    }
  }
}

module.exports = PerformanceTracker;