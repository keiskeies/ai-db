import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ConnectionConfig } from '@aidb/core';
import type { GatewayConfig } from './config';
import type { Store } from './store';

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COUNTRIES = ['中国', '美国', '德国', '日本', '新加坡', '英国', '法国', '加拿大'];
const TIERS = ['free', 'pro', 'enterprise'];
const CHANNELS = ['web', 'app', 'partner'];
const STATUSES = ['completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'pending', 'pending', 'refunded', 'cancelled'];
const PRODUCTS: Array<[string, string, number]> = [
  ['机械键盘 K8', '硬件', 49900],
  ['显示器 27 4K', '硬件', 189900],
  ['人体工学椅', '家具', 129900],
  ['降噪耳机', '硬件', 89900],
  ['升降桌', '家具', 159900],
  ['USB-C 扩展坞', '配件', 32900],
  ['无线鼠标', '配件', 19900],
  ['笔记本支架', '配件', 12900],
  ['摄像头 1080P', '硬件', 29900],
  ['桌面音箱', '硬件', 59900],
  ['显示器挂灯', '配件', 25900],
  ['储物柜', '家具', 89900],
  ['云存储年费', '软件', 19900],
  ['设计软件席位', '软件', 39900],
  ['监控服务月费', '软件', 9900],
  ['数据备份服务', '软件', 14900],
  ['白板 120cm', '办公', 45900],
  ['文件柜', '办公', 69900],
  ['台灯', '办公', 15900],
  ['毯子', '办公', 22900],
  ['水杯', '生活', 5900],
  ['咖啡豆', '生活', 7900],
  ['绿植', '生活', 3900],
  ['香薰', '生活', 6900],
];

export function ensureDemoDatabase(config: GatewayConfig, store: Store): ConnectionConfig {
  const filePath = join(config.demoDir, 'demo-shop.sqlite');
  const isNew = !existsSync(filePath);
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  if (isNew) {
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        country TEXT NOT NULL,
        tier TEXT NOT NULL DEFAULT 'free',
        created_at TEXT NOT NULL
      );
      CREATE TABLE products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        price_cents INTEGER NOT NULL,
        stock INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        status TEXT NOT NULL,
        channel TEXT NOT NULL,
        total_cents INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL REFERENCES orders(id),
        product_id INTEGER NOT NULL REFERENCES products(id),
        qty INTEGER NOT NULL,
        unit_cents INTEGER NOT NULL
      );
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        type TEXT NOT NULL,
        payload TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX ix_orders_status ON orders(status);
      CREATE INDEX ix_orders_created_at ON orders(created_at);
      CREATE INDEX ix_events_type ON events(type);
    `);
    const rand = mulberry32(20261027);
    const now = Date.now();
    const iso = (t: number) => new Date(t).toISOString();
    db.exec('BEGIN');
    try {
      const insertUser = db.prepare("INSERT INTO users (name,email,country,tier,created_at) VALUES (?,?,?,?,?)");
      for (let i = 1; i <= 120; i++) {
        insertUser.run(
          `User ${String(i).padStart(3, '0')}`,
          `user${i}@example.com`,
          COUNTRIES[Math.floor(rand() * COUNTRIES.length)],
          TIERS[Math.floor(rand() * TIERS.length)],
          iso(now - Math.floor(rand() * 365) * 86400000),
        );
      }
      const insertProduct = db.prepare('INSERT INTO products (name,category,price_cents,stock) VALUES (?,?,?,?)');
      for (const [name, category, price] of PRODUCTS) insertProduct.run(name, category, price, 20 + Math.floor(rand() * 180));

      const insertOrder = db.prepare('INSERT INTO orders (user_id,status,channel,total_cents,created_at) VALUES (?,?,?,?,?)');
      const insertItem = db.prepare('INSERT INTO order_items (order_id,product_id,qty,unit_cents) VALUES (?,?,?,?)');
      for (let i = 0; i < 900; i++) {
        const daysAgo = Math.floor(rand() * 120);
        const created = now - daysAgo * 86400000 - Math.floor(rand() * 86400000);
        const status = STATUSES[Math.floor(rand() * STATUSES.length)];
        const userId = 1 + Math.floor(rand() * 120);
        const itemCount = 1 + Math.floor(rand() * 4);
        let total = 0;
        const items: Array<[number, number, number]> = [];
        for (let k = 0; k < itemCount; k++) {
          const productId = 1 + Math.floor(rand() * PRODUCTS.length);
          const qty = 1 + Math.floor(rand() * 3);
          const price = PRODUCTS[productId - 1][2];
          total += price * qty;
          items.push([productId, qty, price]);
        }
        const result = insertOrder.run(userId, status, CHANNELS[Math.floor(rand() * CHANNELS.length)], total, iso(created));
        const orderId = Number(result.lastInsertRowid);
        for (const [productId, qty, price] of items) insertItem.run(orderId, productId, qty, price);
      }
      const insertEvent = db.prepare('INSERT INTO events (user_id,type,payload,created_at) VALUES (?,?,?,?)');
      const types = ['page_view', 'add_to_cart', 'checkout', 'refund_request'];
      for (let i = 0; i < 1500; i++) {
        const daysAgo = Math.floor(rand() * 120);
        insertEvent.run(
          1 + Math.floor(rand() * 120),
          types[Math.floor(rand() * types.length)],
          JSON.stringify({ path: '/product/' + (1 + Math.floor(rand() * PRODUCTS.length)), source: CHANNELS[Math.floor(rand() * CHANNELS.length)] }),
          iso(now - daysAgo * 86400000 - Math.floor(rand() * 86400000)),
        );
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  db.close();

  const existing = store.listConnections().find((c) => c.engine === 'sqlite' && c.database === filePath);
  if (existing) return existing;
  return store.createConnection({
    name: 'Demo · Shop DB',
    engine: 'sqlite',
    color: 'green',
    environment: 'dev',
    groupName: '示例',
    database: filePath,
    readonly: false,
    note: '内置电商示例库：users / products / orders / order_items / events，最近 120 天数据。',
  });
}
