import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ConnectionColor, ConnectionConfig } from '@aidb/core';
import type { GatewayConfig } from './config';
import type { Store } from './store';

/**
 * 业务级示例库：零售 / 电商 / 门店 / 供应链 / 财务 / 客服 / 订阅。
 * 数据既包含可用于报表的规整事实表，也刻意保留一部分脏数据（空值、重复、越界、
 * 大小写不一致），用于数据质量、比对、同步与 Agent 分析类功能的验证。
 *
 * drift=true 时生成“结构漂移 + 行级差异”的镜像库，作为迁移/对比/同步的目标端。
 */

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];
const int = (rng: Rng, min: number, max: number): number => min + Math.floor(rng() * (max - min + 1));
const chance = (rng: Rng, p: number): boolean => rng() < p;
function weighted<T>(rng: Rng, entries: ReadonlyArray<readonly [T, number]>): T {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let hit = rng() * total;
  for (const [value, weight] of entries) {
    hit -= weight;
    if (hit <= 0) return value;
  }
  return entries[entries.length - 1][0];
}

const DAY = 86_400_000;
const NOW = Date.now();
const START = NOW - 540 * DAY;
const fmt = (t: number): string => new Date(t).toISOString().slice(0, 19).replace('T', ' ');
const dayStart = (t: number): number => Math.floor(t / DAY) * DAY;

const SURNAMES = ['王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴', '徐', '孙', '胡', '朱', '高', '林', '何', '郭', '马', '罗', '梁', '宋', '郑', '谢', '韩', '唐', '冯', '于', '董', '萧', '程', '曹', '袁', '邓', '许', '傅', '沈', '曾', '彭', '吕', '苏', '卢', '蒋', '蔡', '贾', '丁', '魏', '薛', '叶', '阎'];
const GIVEN = ['伟', '芳', '娜', '敏', '静', '丽', '强', '磊', '军', '洋', '勇', '艳', '杰', '娟', '涛', '明', '超', '秀英', '霞', '平', '刚', '桂英', '鹏', '婷', '雪', '晨', '宇', '浩', '雨', '琳', '子涵', '欣怡', '思远', '嘉怡', '一鸣', '梓萱', '博文', '诗涵', '俊杰', '梦琪', '天佑', '若曦', '浩然', '语晨', '文博', '雅静', '志强', '晓峰', '建国', '海燕'];
const COMPANY_PREFIX = ['星海', '云图', '远航', '恒达', '汇通', '新程', '博远', '嘉信', '和泰', '锐志', '天工', '万象', '启明', '盛达', '中兴', '东方'];

const REGIONS: Array<[string, string, Array<[string, string, string]>]> = [
  ['华东', 'HD', [['上海市', '一线', '上海市'], ['杭州市', '新一线', '浙江省'], ['南京市', '新一线', '江苏省'], ['苏州市', '二线', '江苏省'], ['宁波市', '二线', '浙江省'], ['合肥市', '二线', '安徽省']]],
  ['华南', 'HN', [['广州市', '一线', '广东省'], ['深圳市', '一线', '广东省'], ['东莞市', '二线', '广东省'], ['佛山市', '二线', '广东省'], ['厦门市', '二线', '福建省'], ['南宁市', '二线', '广西壮族自治区']]],
  ['华北', 'HB', [['北京市', '一线', '北京市'], ['天津市', '新一线', '天津市'], ['石家庄市', '二线', '河北省'], ['太原市', '二线', '山西省']]],
  ['华中', 'HZ', [['武汉市', '新一线', '湖北省'], ['长沙市', '新一线', '湖南省'], ['郑州市', '新一线', '河南省'], ['南昌市', '二线', '江西省']]],
  ['西南', 'XN', [['成都市', '新一线', '四川省'], ['重庆市', '新一线', '重庆市'], ['昆明市', '二线', '云南省'], ['贵阳市', '二线', '贵州省']]],
  ['西北', 'XB', [['西安市', '新一线', '陕西省'], ['兰州市', '二线', '甘肃省'], ['乌鲁木齐市', '二线', '新疆维吾尔自治区']]],
  ['东北', 'DB', [['沈阳市', '二线', '辽宁省'], ['大连市', '二线', '辽宁省'], ['长春市', '二线', '吉林省'], ['哈尔滨市', '二线', '黑龙江省']]],
];

const CATEGORY_DEFS: Array<{ path: [string, string]; nouns: string[]; price: [number, number] }> = [
  { path: ['数码', '手机通讯'], nouns: ['智能手机', '折叠屏手机', '影音手机', '游戏手机'], price: [159900, 899900] },
  { path: ['数码', '电脑办公'], nouns: ['轻薄本', '游戏本', '一体机', '办公显示器'], price: [299900, 1599900] },
  { path: ['数码', '影音娱乐'], nouns: ['降噪耳机', '蓝牙音箱', '头戴耳机', '便携投影仪'], price: [19900, 299900] },
  { path: ['数码', '智能穿戴'], nouns: ['智能手表', '运动手环', '智能眼镜'], price: [39900, 259900] },
  { path: ['家电', '大家电'], nouns: ['对开门冰箱', '滚筒洗衣机', '变频空调', '超薄电视'], price: [129900, 899900] },
  { path: ['家电', '厨房电器'], nouns: ['洗碗机', '微波炉', '电饭煲', '破壁机'], price: [29900, 299900] },
  { path: ['家电', '生活电器'], nouns: ['扫地机器人', '空气净化器', '除湿机', '挂烫机'], price: [39900, 349900] },
  { path: ['服饰', '男装'], nouns: ['纯棉衬衫', '休闲西裤', '羽绒服', '针织开衫'], price: [9900, 89900] },
  { path: ['服饰', '女装'], nouns: ['真丝连衣裙', '羊毛大衣', '高腰牛仔裤', '针织套装'], price: [12900, 129900] },
  { path: ['服饰', '鞋靴箱包'], nouns: ['运动鞋', '通勤皮鞋', '双肩包', '拉杆箱'], price: [19900, 159900] },
  { path: ['美妆', '护肤'], nouns: ['抗老精华', '修护面霜', '洁面乳', '防晒霜'], price: [6900, 89900] },
  { path: ['美妆', '彩妆'], nouns: ['粉底液', '口红礼盒', '眼影盘', '定妆喷雾'], price: [4900, 59900] },
  { path: ['食品', '休闲零食'], nouns: ['每日坚果', '手工曲奇', '风干牛肉', '冻干水果'], price: [2900, 19900] },
  { path: ['食品', '粮油调味'], nouns: ['五常大米', '初榨橄榄油', '有机酱油', '杂粮礼盒'], price: [3900, 29900] },
  { path: ['食品', '生鲜'], nouns: ['冷链牛排', '阳澄湖大闸蟹', '进口车厘子', '鲜牛奶'], price: [3900, 39900] },
  { path: ['家居', '家具'], nouns: ['实木书桌', '布艺沙发', '人体工学椅', '五斗柜'], price: [39900, 499900] },
  { path: ['家居', '家纺'], nouns: ['全棉四件套', '鹅绒被', '乳胶枕', '遮光窗帘'], price: [12900, 129900] },
  { path: ['家居', '厨具'], nouns: ['不粘炒锅', '珐琅锅', '刀具套装', '保温杯'], price: [4900, 69900] },
  { path: ['母婴', '奶粉辅食'], nouns: ['婴幼儿奶粉', '有机米粉', '果泥套装'], price: [8900, 45900] },
  { path: ['母婴', '纸尿裤'], nouns: ['超薄纸尿裤', '拉拉裤', '湿巾组合'], price: [5900, 25900] },
  { path: ['母婴', '玩具'], nouns: ['积木套装', '早教机', '毛绒玩偶'], price: [3900, 49900] },
  { path: ['运动', '健身器材'], nouns: ['可调哑铃', '划船机', '瑜伽垫', '筋膜枪'], price: [3900, 399900] },
  { path: ['运动', '户外装备'], nouns: ['冲锋衣', '登山杖', '露营帐篷', '保温壶'], price: [9900, 259900] },
  { path: ['图书', '文学小说'], nouns: ['长篇小说', '散文集', '诗歌选集'], price: [2900, 8900] },
  { path: ['图书', '科技经管'], nouns: ['技术专著', '管理经典', '经济读物'], price: [3900, 12900] },
];

const BRANDS = ['星辰', '云栖', 'Northpeak', 'Lumio', 'Aster', '恒美', 'Mori', '光年', '简白', 'Velora', '拓野', 'Harbor', '元気', 'AquaPure', 'Casa', 'Terra', '小鹿', 'Kito', 'Aurora', 'Mellow', 'Zenith', '绿洲', 'Pico', 'Nova', '山海'];

const PRODUCT_ADJ = ['轻享', '臻选', '经典', '专业', '旗舰', '入门', '限定', '焕新', '智享', '悦动'];
const ORDER_CHANNELS = ['小程序', 'APP', 'PC 商城', '抖音小店', '天猫', '京东', '线下门店'];
const CHANNEL_WEIGHTS: ReadonlyArray<readonly [string, number]> = [['小程序', 30], ['APP', 22], ['PC 商城', 10], ['抖音小店', 14], ['天猫', 11], ['京东', 8], ['线下门店', 5]];
const ORDER_STATUS: ReadonlyArray<readonly [string, number]> = [['completed', 60], ['pending', 7], ['paid', 6], ['shipped', 9], ['delivered', 6], ['cancelled', 6], ['refunded', 4], ['closed', 2]];
const PAY_METHODS: ReadonlyArray<readonly [string, number]> = [['wechat', 42], ['alipay', 33], ['unionpay', 10], ['applepay', 8], ['cash', 4], ['corporate', 3]];
const CARRIERS = ['顺丰速运', '中通快递', '圆通速递', '韵达快递', '京东物流', '邮政EMS'];
const TICKET_CATEGORIES = ['物流延迟', '退换货', '发票问题', '商品咨询', '账号安全', '支付异常'];
const TICKET_PRIORITIES: ReadonlyArray<readonly [string, number]> = [['low', 40], ['normal', 40], ['high', 15], ['urgent', 5]];
const SUB_PLANS: Array<[string, number]> = [['基础版', 9900], ['专业版', 29900], ['旗舰版', 69900], ['企业版', 199900]];
const CITIES: Array<{ id: number; name: string; tier: string; regionId: number; province: string }> = [];
const STORES: Array<{ id: number; cityId: number; regionId: number; name: string }> = [];
const EMPLOYEES: Array<{ id: number; storeId: number; deptId: number }> = [];
const WAREHOUSES: Array<{ id: number; cityId: number }> = [];

function chineseName(rng: Rng): string {
  return pick(rng, SURNAMES) + pick(rng, GIVEN);
}
function phone(rng: Rng): string {
  const prefix = pick(rng, ['138', '139', '150', '151', '158', '186', '188', '199', '133', '177']);
  let tail = '';
  for (let i = 0; i < 8; i++) tail += Math.floor(rng() * 10);
  return prefix + tail;
}
function emailFor(name: string, i: number, rng: Rng): string {
  const domains = ['example.com', 'qq.com', '163.com', 'outlook.com', 'gmail.com', '126.com'];
  return `user${i}.${Math.floor(rng() * 999)}@${pick(rng, domains)}`;
}

interface DdlOptions {
  drift: boolean;
}

function ddl(options: DdlOptions): string {
  const missing = options.drift;
  return `
    CREATE TABLE regions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code VARCHAR(8) NOT NULL UNIQUE,
      name VARCHAR(32) NOT NULL,
      manager_name VARCHAR(32),
      created_at DATETIME NOT NULL
    );
    CREATE TABLE cities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name VARCHAR(32) NOT NULL,
      province VARCHAR(32) NOT NULL,
      tier VARCHAR(16) NOT NULL,
      region_id INTEGER NOT NULL REFERENCES regions(id),
      postcode VARCHAR(8)
    );
    CREATE TABLE departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name VARCHAR(64) NOT NULL,
      parent_id INTEGER,
      cost_center VARCHAR(16),
      headcount_budget INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL
    );
    CREATE TABLE stores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code VARCHAR(16) NOT NULL UNIQUE,
      name VARCHAR(64) NOT NULL,
      city_id INTEGER NOT NULL REFERENCES cities(id),
      region_id INTEGER NOT NULL REFERENCES regions(id),
      format VARCHAR(16) NOT NULL,
      area_sqm DECIMAL(8,2) NOT NULL,
      opened_at DATE NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'open',
      manager_emp_id INTEGER,
      monthly_rent_cents INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      emp_no VARCHAR(16) NOT NULL UNIQUE,
      name VARCHAR(32) NOT NULL,
      gender VARCHAR(8) NOT NULL,
      store_id INTEGER NOT NULL REFERENCES stores(id),
      dept_id INTEGER NOT NULL REFERENCES departments(id),
      position VARCHAR(32) NOT NULL,
      hire_date DATE NOT NULL,
      salary_cents INTEGER NOT NULL,
      manager_id INTEGER,
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      phone VARCHAR(20),
      email VARCHAR(128) UNIQUE
    );
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_no VARCHAR(16) NOT NULL UNIQUE,
      name VARCHAR(64) NOT NULL,
      nickname VARCHAR(64),
      gender VARCHAR(8) NOT NULL DEFAULT '未知',
      birth_date DATE,
      mobile VARCHAR(24),
      email VARCHAR(128),
      channel_source VARCHAR(24) NOT NULL,
      city_id INTEGER REFERENCES cities(id),
      vip_level VARCHAR(16) NOT NULL DEFAULT '普通会员',
      member_points INTEGER NOT NULL DEFAULT 0,
      registered_at DATETIME NOT NULL,
      last_login_at DATETIME,
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      consent_marketing BOOLEAN NOT NULL DEFAULT 0
    );
    CREATE TABLE customer_addresses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      receiver VARCHAR(32) NOT NULL,
      phone VARCHAR(24) NOT NULL,
      province VARCHAR(32) NOT NULL,
      city VARCHAR(32) NOT NULL,
      district VARCHAR(32) NOT NULL,
      detail VARCHAR(255) NOT NULL,
      postcode VARCHAR(8),
      is_default BOOLEAN NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL
    );
    CREATE TABLE categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name VARCHAR(32) NOT NULL,
      parent_id INTEGER,
      level INTEGER NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT 1
    );
    CREATE TABLE brands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name VARCHAR(64) NOT NULL UNIQUE,
      country VARCHAR(32),
      founded_year INTEGER,
      is_partner BOOLEAN NOT NULL DEFAULT 0
    );
    CREATE TABLE products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku VARCHAR(32) NOT NULL UNIQUE,
      name VARCHAR(128) NOT NULL,
      category_id INTEGER NOT NULL REFERENCES categories(id),
      brand_id INTEGER NOT NULL REFERENCES brands(id),
      price_cents INTEGER NOT NULL,
      cost_cents INTEGER NOT NULL,
      stock INTEGER NOT NULL DEFAULT 0,
      unit VARCHAR(8) NOT NULL DEFAULT '件',
      weight_gram INTEGER,
      status VARCHAR(16) NOT NULL DEFAULT 'on_sale',
      launched_at DATE,
      description TEXT,
      attrs JSON,
      ${missing ? 'warehouse_code VARCHAR(16)' : 'rating DECIMAL(3,2)'}
    );
    CREATE TABLE product_variants (
      product_id INTEGER NOT NULL REFERENCES products(id),
      spec_value VARCHAR(32) NOT NULL,
      spec_name VARCHAR(16) NOT NULL,
      sku_suffix VARCHAR(16) NOT NULL,
      price_delta_cents INTEGER NOT NULL DEFAULT 0,
      stock INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (product_id, spec_value)
    );
    ${missing ? '' : `CREATE TABLE product_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id),
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      order_id INTEGER,
      rating INTEGER NOT NULL,
      content TEXT,
      has_image BOOLEAN NOT NULL DEFAULT 0,
      helpful_count INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL
    );`}
    CREATE TABLE warehouses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code VARCHAR(16) NOT NULL UNIQUE,
      name VARCHAR(64) NOT NULL,
      city_id INTEGER NOT NULL REFERENCES cities(id),
      type VARCHAR(16) NOT NULL,
      capacity_pallet INTEGER NOT NULL,
      manager_name VARCHAR(32)
    );
    CREATE TABLE inventory (
      product_id INTEGER NOT NULL REFERENCES products(id),
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      qty INTEGER NOT NULL DEFAULT 0,
      safety_qty INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL,
      PRIMARY KEY (product_id, warehouse_id)
    );
    CREATE TABLE stock_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id),
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      movement_type VARCHAR(16) NOT NULL,
      qty_delta INTEGER NOT NULL,
      ref_no VARCHAR(32),
      operator_emp_id INTEGER,
      occurred_at DATETIME NOT NULL
    );
    CREATE TABLE suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code VARCHAR(16) NOT NULL UNIQUE,
      name VARCHAR(128) NOT NULL,
      contact_name VARCHAR(32),
      contact_phone VARCHAR(24),
      city_id INTEGER REFERENCES cities(id),
      settle_days INTEGER NOT NULL DEFAULT 30,
      rating DECIMAL(3,1),
      cooperation_since DATE,
      status VARCHAR(16) NOT NULL DEFAULT 'active'
    );
    CREATE TABLE purchase_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_no VARCHAR(24) NOT NULL UNIQUE,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      buyer_emp_id INTEGER REFERENCES employees(id),
      status VARCHAR(16) NOT NULL,
      ordered_at DATETIME NOT NULL,
      expected_at DATE,
      arrived_at DATETIME,
      amount_cents INTEGER NOT NULL
    );
    CREATE TABLE purchase_order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      qty INTEGER NOT NULL,
      unit_cost_cents INTEGER NOT NULL,
      received_qty INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no VARCHAR(32) NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      store_id INTEGER REFERENCES stores(id),
      channel VARCHAR(24) NOT NULL,
      status VARCHAR(16) NOT NULL,
      payment_method VARCHAR(16),
      coupon_code VARCHAR(32),
      goods_${missing ? 'amount_' : ''}cents INTEGER NOT NULL,
      freight_cents INTEGER NOT NULL DEFAULT 0,
      discount_cents INTEGER NOT NULL DEFAULT 0,
      pay_cents INTEGER NOT NULL,
      points_used INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL,
      paid_at DATETIME,
      shipped_at DATETIME,
      completed_at DATETIME,
      delivery_date DATE,
      remark VARCHAR(255),
      ${missing ? 'sync_at DATETIME' : 'invoice_title VARCHAR(128)'},
      is_test_order BOOLEAN NOT NULL DEFAULT 0
    );
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      variant TEXT,
      qty INTEGER NOT NULL,
      unit_price_cents INTEGER NOT NULL,
      discount_cents INTEGER NOT NULL DEFAULT 0,
      refund_status VARCHAR(16) NOT NULL DEFAULT 'none'
    );
    CREATE TABLE order_status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      from_status VARCHAR(16),
      to_status VARCHAR(16) NOT NULL,
      changed_at DATETIME NOT NULL,
      changed_by VARCHAR(32)
    );
    CREATE TABLE payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_no VARCHAR(32) NOT NULL UNIQUE,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      method VARCHAR(16) NOT NULL,
      amount_cents INTEGER NOT NULL,
      status VARCHAR(16) NOT NULL,
      trade_no VARCHAR(64),
      gateway_fee_cents INTEGER NOT NULL DEFAULT 0,
      paid_at DATETIME
    );
    CREATE TABLE refunds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      refund_no VARCHAR(32) NOT NULL UNIQUE,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      order_item_id INTEGER REFERENCES order_items(id),
      amount_cents INTEGER NOT NULL,
      reason VARCHAR(32) NOT NULL,
      status VARCHAR(16) NOT NULL,
      created_at DATETIME NOT NULL,
      finished_at DATETIME
    );
    CREATE TABLE shipments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_no VARCHAR(32) NOT NULL UNIQUE,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      carrier VARCHAR(32) NOT NULL,
      tracking_no VARCHAR(32) NOT NULL,
      province VARCHAR(32),
      city VARCHAR(32),
      weight_kg DECIMAL(8,2),
      freight_cents INTEGER NOT NULL DEFAULT 0,
      status VARCHAR(16) NOT NULL,
      shipped_at DATETIME NOT NULL,
      delivered_at DATETIME
    );
    CREATE TABLE coupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code VARCHAR(32) NOT NULL UNIQUE,
      name VARCHAR(64) NOT NULL,
      type VARCHAR(16) NOT NULL,
      threshold_cents INTEGER NOT NULL DEFAULT 0,
      discount_cents INTEGER NOT NULL,
      issued_at DATETIME NOT NULL,
      expire_at DATETIME NOT NULL,
      quota INTEGER NOT NULL,
      used_count INTEGER NOT NULL DEFAULT 0,
      status VARCHAR(16) NOT NULL DEFAULT 'active'
    );
    CREATE TABLE coupon_redemptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coupon_id INTEGER NOT NULL REFERENCES coupons(id),
      order_id INTEGER NOT NULL REFERENCES orders(id),
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      discount_cents INTEGER NOT NULL,
      redeemed_at DATETIME NOT NULL
    );
    CREATE TABLE marketing_campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name VARCHAR(128) NOT NULL,
      channel VARCHAR(32) NOT NULL,
      segment VARCHAR(32) NOT NULL,
      budget_cents INTEGER NOT NULL,
      start_at DATETIME NOT NULL,
      end_at DATETIME NOT NULL,
      owner_emp_id INTEGER REFERENCES employees(id),
      status VARCHAR(16) NOT NULL
    );
    CREATE TABLE campaign_touches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES marketing_campaigns(id),
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      touch_type VARCHAR(16) NOT NULL,
      touched_at DATETIME NOT NULL,
      clicked BOOLEAN NOT NULL DEFAULT 0,
      converted BOOLEAN NOT NULL DEFAULT 0,
      cost_cents INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subscription_no VARCHAR(32) NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      plan VARCHAR(32) NOT NULL,
      status VARCHAR(16) NOT NULL,
      seats INTEGER NOT NULL DEFAULT 1,
      mrr_cents INTEGER NOT NULL,
      started_at DATETIME NOT NULL,
      renews_at DATETIME,
      cancelled_at DATETIME,
      auto_renew BOOLEAN NOT NULL DEFAULT 1,
      cancel_reason VARCHAR(64)
    );
    CREATE TABLE finance_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_no VARCHAR(32) NOT NULL UNIQUE,
      booked_at DATE NOT NULL,
      account_code VARCHAR(16) NOT NULL,
      account_name VARCHAR(64) NOT NULL,
      summary VARCHAR(255),
      debit_cents INTEGER NOT NULL DEFAULT 0,
      credit_cents INTEGER NOT NULL DEFAULT 0,
      related_order_id INTEGER,
      department_id INTEGER REFERENCES departments(id),
      created_by_emp_id INTEGER,
      currency VARCHAR(8) NOT NULL DEFAULT 'CNY'
    );
    CREATE TABLE support_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_no VARCHAR(32) NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      order_id INTEGER REFERENCES orders(id),
      category VARCHAR(32) NOT NULL,
      priority VARCHAR(16) NOT NULL,
      status VARCHAR(16) NOT NULL,
      title VARCHAR(255) NOT NULL,
      content TEXT,
      assignee_emp_id INTEGER,
      csat INTEGER,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    );
    CREATE TABLE ticket_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES support_tickets(id),
      sender_type VARCHAR(16) NOT NULL,
      sender_name VARCHAR(32),
      content TEXT NOT NULL,
      created_at DATETIME NOT NULL
    );
    CREATE TABLE web_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER,
      session_id VARCHAR(40) NOT NULL,
      event_type VARCHAR(32) NOT NULL,
      page_path VARCHAR(255),
      referrer VARCHAR(255),
      device VARCHAR(16),
      os VARCHAR(16),
      app_version VARCHAR(16),
      city_id INTEGER,
      occurred_at DATETIME NOT NULL,
      duration_ms INTEGER,
      payload JSON
    );
    CREATE TABLE daily_metrics (
      metric_date DATE NOT NULL,
      channel VARCHAR(24) NOT NULL,
      gmv_cents INTEGER NOT NULL,
      order_cnt INTEGER NOT NULL,
      paid_order_cnt INTEGER NOT NULL,
      refund_cnt INTEGER NOT NULL,
      new_customer_cnt INTEGER NOT NULL,
      uv INTEGER NOT NULL,
      pv INTEGER NOT NULL,
      cvr DECIMAL(6,4) NOT NULL,
      aov_cents INTEGER NOT NULL,
      PRIMARY KEY (metric_date, channel)
    );
    CREATE TABLE product_daily_stats (
      stat_date DATE NOT NULL,
      product_id INTEGER NOT NULL REFERENCES products(id),
      exposure INTEGER NOT NULL,
      clicks INTEGER NOT NULL,
      sales_cnt INTEGER NOT NULL,
      sales_cents INTEGER NOT NULL,
      PRIMARY KEY (stat_date, product_id)
    );
    ${missing ? '' : `CREATE TABLE customer_avatars (
      customer_id INTEGER PRIMARY KEY REFERENCES customers(id),
      content_type VARCHAR(32) NOT NULL,
      data BLOB NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      uploaded_at DATETIME NOT NULL
    );`}
    ${missing ? '' : `CREATE TABLE legacy_order_export (
      order_no TEXT,
      customer TEXT,
      amount TEXT,
      created TEXT,
      status_cn TEXT,
      memo TEXT
    );`}
    CREATE TABLE "order" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "group" TEXT,
      "order" TEXT,
      "select" TEXT,
      "desc" TEXT,
      "user" TEXT
    );
    CREATE VIEW v_order_summary AS
      SELECT o.id AS order_id, o.order_no, c.name AS customer_name, c.customer_no,
             o.channel, o.status, o.${missing ? 'goods_amount_cents' : 'goods_cents'} AS goods_cents, o.discount_cents, o.pay_cents,
             o.created_at, s.name AS store_name
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN stores s ON s.id = o.store_id;
    CREATE VIEW v_category_sales AS
      SELECT cat.id AS category_id, cat.name AS category_name,
             COUNT(DISTINCT p.id) AS product_cnt,
             COALESCE(SUM(oi.qty), 0) AS units_sold,
             COALESCE(SUM(oi.qty * oi.unit_price_cents - oi.discount_cents), 0) AS sales_cents
      FROM categories cat
      LEFT JOIN products p ON p.category_id = cat.id
      LEFT JOIN order_items oi ON oi.product_id = p.id
      GROUP BY cat.id, cat.name;
    ${missing ? '' : `CREATE INDEX ix_product_reviews_product ON product_reviews(product_id, created_at);`}
    CREATE INDEX ix_orders_created ON orders(created_at);
    CREATE INDEX ix_orders_status ON orders(status);
    CREATE INDEX ix_orders_customer ON orders(customer_id);
    CREATE INDEX ix_order_items_order ON order_items(order_id);
    CREATE INDEX ix_order_items_product ON order_items(product_id);
    CREATE INDEX ix_payments_order ON payments(order_id);
    CREATE INDEX ix_web_events_time ON web_events(occurred_at);
    CREATE INDEX ix_web_events_type ON web_events(event_type);
    CREATE INDEX ix_stock_movements_product ON stock_movements(product_id, occurred_at);
    CREATE INDEX ix_tickets_status ON support_tickets(status, created_at);
    CREATE INDEX ix_customers_mobile ON customers(mobile);
    CREATE INDEX ix_inventory_wh ON inventory(warehouse_id);
  `;
}

export interface BuildOptions {
  drift?: boolean;
  force?: boolean;
}

export function buildBusinessDemoDatabase(filePath: string, options: BuildOptions = {}): void {
  const drift = options.drift === true;
  if (existsSync(filePath) && !options.force) return;
  mkdirSync(dirname(filePath), { recursive: true });
  if (options.force) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(filePath + suffix, { force: true });
  }
  const db = new DatabaseSync(filePath);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(ddl({ drift }));
    seedAll(db, drift);
    if (!drift) {
      db.exec(`
        CREATE TRIGGER trg_order_status_log AFTER UPDATE OF status ON orders
        BEGIN
          INSERT INTO order_status_history (order_id, from_status, to_status, changed_at, changed_by)
          VALUES (OLD.id, OLD.status, NEW.status, datetime('now'), 'trigger');
        END;
        CREATE TRIGGER trg_inventory_audit AFTER UPDATE OF qty ON inventory
        WHEN NEW.qty <> OLD.qty
        BEGIN
          INSERT INTO stock_movements (product_id, warehouse_id, movement_type, qty_delta, ref_no, occurred_at)
          VALUES (NEW.product_id, NEW.warehouse_id, 'adjust', NEW.qty - OLD.qty, 'AUDIT', datetime('now'));
        END;
      `);
    }
  } finally {
    db.close();
  }
}

function seedAll(db: DatabaseSync, drift: boolean): void {
  const rng = mulberry32(drift ? 7_2026_11_02 : 2_026_11_02);
  CITIES.length = 0;
  STORES.length = 0;
  EMPLOYEES.length = 0;
  WAREHOUSES.length = 0;
  db.exec('BEGIN');
  try {
    seedOrg(db, rng);
    seedCatalog(db, rng, drift);
    seedProcurement(db, rng);
    seedCustomers(db, rng, drift);
    seedInventory(db, rng);
    seedCoupons(db, rng);
    seedOrders(db, rng, drift);
    seedMarketing(db, rng);
    seedSubscriptions(db, rng);
    seedFinance(db, rng);
    seedSupport(db, rng);
    seedWebAnalytics(db, rng);
    seedMisc(db, rng, drift);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function seedOrg(db: DatabaseSync, rng: Rng): void {
  const insertRegion = db.prepare('INSERT INTO regions (code,name,manager_name,created_at) VALUES (?,?,?,?)');
  REGIONS.forEach(([name, code], i) => insertRegion.run(code, name, chineseName(rng), fmt(START + i * DAY)));
  let cityId = 0;
  const insertCity = db.prepare('INSERT INTO cities (name,province,tier,region_id,postcode) VALUES (?,?,?,?,?)');
  REGIONS.forEach(([, , cities], regionIndex) => {
    for (const [cityName, tier, province] of cities) {
      cityId += 1;
      insertCity.run(cityName, province, tier, regionIndex + 1, String(100000 + int(rng, 0, 899999)));
      CITIES.push({ id: cityId, name: cityName, tier, regionId: regionIndex + 1, province });
    }
  });

  const deptNames = ['总经办', '电商运营部', '线下零售部', '商品采购部', '供应链部', '市场品牌部', '客户服务部', '财务部', '人力资源部', '信息技术部', '数据智能部', '仓储物流部'];
  const insertDept = db.prepare('INSERT INTO departments (name,parent_id,cost_center,headcount_budget,created_at) VALUES (?,?,?,?,?)');
  deptNames.forEach((name, i) => insertDept.run(name, i === 0 ? null : 1, `CC${String(1001 + i)}`, int(rng, 5, 80), fmt(START + i * DAY)));

  const storeFormats: ReadonlyArray<readonly [string, number]> = [['旗舰店', 15], ['标准店', 50], ['社区店', 25], ['快闪店', 10]];
  const insertStore = db.prepare('INSERT INTO stores (code,name,city_id,region_id,format,area_sqm,opened_at,status,manager_emp_id,monthly_rent_cents) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const insertEmp = db.prepare('INSERT INTO employees (emp_no,name,gender,store_id,dept_id,position,hire_date,salary_cents,manager_id,status,phone,email) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const positions = ['店长', '副店长', '导购', '收银员', '库存管理员', '陈列专员'];
  let empId = 0;
  for (let i = 1; i <= 60; i++) {
    const city = pick(rng, CITIES);
    const format = weighted(rng, storeFormats);
    insertStore.run(
      `ST${String(i).padStart(3, '0')}`,
      `${city.name.replace(/市$/, '')}${format}${i}`,
      city.id,
      city.regionId,
      format,
      Math.round((80 + rng() * 900) * 100) / 100,
      new Date(START + int(rng, 0, 500) * DAY).toISOString().slice(0, 10),
      chance(rng, 0.04) ? 'closed' : 'open',
      null,
      int(rng, 200000, 2500000),
    );
    STORES.push({ id: i, cityId: city.id, regionId: city.regionId, name: `${city.name}门店${i}` });
    const headcount = int(rng, 3, 9);
    for (let k = 0; k < headcount; k++) {
      empId += 1;
      const position = k === 0 ? '店长' : pick(rng, positions);
      insertEmp.run(
        `E${String(empId).padStart(5, '0')}`,
        chineseName(rng),
        weighted(rng, [['F', 55], ['M', 45]] as const),
        i,
        position === '店长' ? 3 : int(rng, 2, 12),
        position,
        new Date(START + int(rng, -300, 500) * DAY).toISOString().slice(0, 10),
        int(rng, 450000, 1800000),
        null,
        chance(rng, 0.05) ? 'resigned' : 'active',
        phone(rng),
        `emp${empId}@retail-demo.cn`,
      );
      EMPLOYEES.push({ id: empId, storeId: i, deptId: 3 });
    }
    db.prepare('UPDATE stores SET manager_emp_id = ? WHERE id = ?').run(empId - headcount + 1, i);
  }

  const insertWarehouse = db.prepare('INSERT INTO warehouses (code,name,city_id,type,capacity_pallet,manager_name) VALUES (?,?,?,?,?,?)');
  const warehouseCities = [CITIES[0], CITIES[5], CITIES[7], CITIES[11], CITIES[15], CITIES[17], CITIES[20], CITIES[23], CITIES[26], CITIES[29]];
  warehouseCities.forEach((city, i) => {
    insertWarehouse.run(`WH${String(i + 1).padStart(2, '0')}`, `${city.name.replace(/市$/, '')}中心仓`, city.id, i < 3 ? '中心仓' : '区域仓', int(rng, 5000, 30000), chineseName(rng));
    WAREHOUSES.push({ id: i + 1, cityId: city.id });
  });

  const insertSupplier = db.prepare('INSERT INTO suppliers (code,name,contact_name,contact_phone,city_id,settle_days,rating,cooperation_since,status) VALUES (?,?,?,?,?,?,?,?,?)');
  for (let i = 1; i <= 36; i++) {
    const city = pick(rng, CITIES);
    insertSupplier.run(
      `SUP${String(i).padStart(3, '0')}`,
      `${pick(rng, COMPANY_PREFIX)}${pick(rng, ['供应链', '贸易', '实业', '科技', '商贸'])}有限公司`,
      chineseName(rng),
      phone(rng),
      city.id,
      weighted(rng, [[15, 20], [30, 40], [45, 20], [60, 15], [90, 5]] as const),
      Math.round((3 + rng() * 2) * 10) / 10,
      new Date(START - int(rng, 0, 900) * DAY).toISOString().slice(0, 10),
      chance(rng, 0.08) ? 'paused' : 'active',
    );
  }
}

function seedProcurement(db: DatabaseSync, rng: Rng): void {
  const insertPo = db.prepare('INSERT INTO purchase_orders (po_no,supplier_id,warehouse_id,buyer_emp_id,status,ordered_at,expected_at,arrived_at,amount_cents) VALUES (?,?,?,?,?,?,?,?,?)');
  const insertPoItem = db.prepare('INSERT INTO purchase_order_items (po_id,product_id,qty,unit_cost_cents,received_qty) VALUES (?,?,?,?,?)');
  for (let i = 1; i <= 1200; i++) {
    const ordered = START + int(rng, 0, 530) * DAY + int(rng, 8, 20) * 3_600_000;
    const status = weighted(rng, [['received', 78], ['in_transit', 10], ['draft', 6], ['cancelled', 6]] as const);
    const result = insertPo.run(
      `PO${new Date(ordered).toISOString().slice(0, 10).replace(/-/g, '')}${String(i).padStart(4, '0')}`,
      1 + int(rng, 0, 35),
      1 + int(rng, 0, 9),
      EMPLOYEES.length ? pick(rng, EMPLOYEES).id : null,
      status,
      fmt(ordered),
      new Date(ordered + int(rng, 3, 15) * DAY).toISOString().slice(0, 10),
      status === 'received' ? fmt(ordered + int(rng, 2, 20) * DAY) : null,
      0,
    );
    const poId = Number(result.lastInsertRowid);
    let amount = 0;
    const lineCount = int(rng, 2, 5);
    for (let k = 0; k < lineCount; k++) {
      const productId = 1 + int(rng, 0, 599);
      const qty = int(rng, 20, 500);
      const cost = int(rng, 1000, 600000);
      amount += qty * cost;
      insertPoItem.run(poId, productId, qty, cost, status === 'received' ? qty : int(rng, 0, qty));
    }
    db.prepare('UPDATE purchase_orders SET amount_cents = ? WHERE id = ?').run(amount, poId);
  }
}

function seedCatalog(db: DatabaseSync, rng: Rng, drift: boolean): void {
  const driftProductColumn = drift ? 'warehouse_code' : 'rating';
  const insertCategory = db.prepare('INSERT INTO categories (name,parent_id,level,sort_order,is_active) VALUES (?,?,?,?,?)');  insertCategory.run('全部分类', null, 0, 0, 1);
  const level1 = new Map<string, number>();
  let level1Index = 0;
  for (const def of CATEGORY_DEFS) {
    const parentName = def.path[0];
    if (!level1.has(parentName)) {
      level1Index += 1;
      insertCategory.run(parentName, 1, 1, level1Index, 1);
      level1.set(parentName, level1Index + 1);
    }
  }
  const leafIds: number[] = [];
  let nextLeaf = 1 + level1.size;
  for (const def of CATEGORY_DEFS) {
    nextLeaf += 1;
    insertCategory.run(def.path[1], level1.get(def.path[0]) ?? 2, 2, nextLeaf, 1);
    leafIds.push(nextLeaf);
  }

  const insertBrand = db.prepare('INSERT INTO brands (name,country,founded_year,is_partner) VALUES (?,?,?,?)');
  BRANDS.forEach((name) =>
    insertBrand.run(name, pick(rng, ['中国', '中国', '中国', '日本', '美国', '德国', '法国', '芬兰']), 1950 + int(rng, 0, 70), chance(rng, 0.35) ? 1 : 0),
  );

  const insertProduct = db.prepare(
    `INSERT INTO products (sku,name,category_id,brand_id,price_cents,cost_cents,stock,unit,weight_gram,status,launched_at,description,attrs,${driftProductColumn})
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insertVariant = db.prepare('INSERT INTO product_variants (product_id,spec_value,spec_name,sku_suffix,price_delta_cents,stock) VALUES (?,?,?,?,?,?)');
  const units = ['件', '台', '盒', '袋', '套', '瓶'];
  for (let i = 1; i <= 600; i++) {
    const def = CATEGORY_DEFS[(i - 1) % CATEGORY_DEFS.length];
    const price = int(rng, def.price[0], def.price[1]);
    const cost = Math.round(price * (0.42 + rng() * 0.36));
    const status = weighted(rng, [['on_sale', 88], ['offline', 8], ['pre_sale', 4]] as const);
    const launch = new Date(START - int(rng, 0, 700) * DAY).toISOString().slice(0, 10);
    const result = insertProduct.run(
      `SKU${String(i).padStart(6, '0')}`,
      `${pick(rng, BRANDS)} ${pick(rng, PRODUCT_ADJ)}${pick(rng, def.nouns)} ${String.fromCharCode(65 + (i % 6))}${int(rng, 1, 99)}`,
      leafIds[(i - 1) % leafIds.length],
      1 + int(rng, 0, BRANDS.length - 1),
      price,
      cost,
      int(rng, 0, 3200),
      pick(rng, units),
      int(rng, 120, 12000),
      status,
      launch,
      `${def.path[0]}类目商品，${pick(rng, ['京东仓直发', '品牌官方旗舰店发货', '支持七天无理由退换', '全国联保'])}。${pick(rng, ['适合日常使用。', '礼盒包装，送礼体面。', '新老包装随机发货。', ''])}`,
      JSON.stringify({ 颜色: pick(rng, ['曜石黑', '月光白', '雾霾蓝', '松石绿']), 规格: pick(rng, ['标准版', '升级版', '家庭装', '礼盒装']) }),
      drift ? `WH${String(int(rng, 1, 10)).padStart(2, '0')}` : status === 'pre_sale' ? null : Math.round((3.5 + rng() * 1.5) * 100) / 100,
    );
    const productId = Number(result.lastInsertRowid);
    const variantCount = int(rng, 0, 4);
    const specs = ['颜色:曜石黑', '颜色:月光白', '规格:升级版', '规格:家庭装', '容量:512G'];
    for (let k = 0; k < variantCount; k++) {
      const [specName, specValue] = specs[k].split(':');
      insertVariant.run(productId, specValue, specName, `${k + 1}`, int(rng, -2000, 8000), int(rng, 0, 600));
    }
  }

  const insertMovement = db.prepare('INSERT INTO stock_movements (product_id,warehouse_id,movement_type,qty_delta,ref_no,operator_emp_id,occurred_at) VALUES (?,?,?,?,?,?,?)');
  for (let i = 0; i < 30000; i++) {
    const type = weighted(rng, [['in', 40], ['out', 40], ['adjust', 8], ['transfer', 8], ['return', 4]] as const);
    insertMovement.run(
      1 + int(rng, 0, 599),
      1 + int(rng, 0, 9),
      type,
      type === 'out' ? -int(rng, 1, 60) : type === 'adjust' ? int(rng, -20, 20) : int(rng, 5, 400),
      type === 'in' ? `PO2025${String(int(rng, 1, 9)).padStart(2, '0')}${String(int(rng, 0, 999)).padStart(4, '0')}` : `SO${int(rng, 100000, 999999)}`,
      EMPLOYEES.length ? pick(rng, EMPLOYEES).id : null,
      fmt(START + int(rng, 0, 540) * DAY + int(rng, 0, 86_399) * 1000),
    );
  }
}

function seedCustomers(db: DatabaseSync, rng: Rng, drift: boolean): void {
  const insert = db.prepare('INSERT INTO customers (customer_no,name,nickname,gender,birth_date,mobile,email,channel_source,city_id,vip_level,member_points,registered_at,last_login_at,status,consent_marketing) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const vipLevels: ReadonlyArray<readonly [string, number]> = [['普通会员', 55], ['银卡会员', 25], ['金卡会员', 14], ['黑金会员', 6]];
  const channels = ['自然注册', '朋友推荐', '广告投放', '线下门店', '小程序裂变', '企业采购'];
  for (let i = 1; i <= 3000; i++) {
    const name = chineseName(rng);
    const registered = START + int(rng, 0, 530) * DAY + int(rng, 0, 86_399) * 1000;
    const dirty = chance(rng, 0.06);
    insert.run(
      `C${String(i).padStart(6, '0')}`,
      dirty && chance(rng, 0.4) ? ` ${name} ` : name,
      chance(rng, 0.6) ? pick(rng, ['小' + pick(rng, GIVEN), '阿' + pick(rng, SURNAMES), pick(rng, ['风一样的男子', '柠檬不酸', '夜航星', '一只猫', '山间清晨'])]) : null,
      weighted(rng, [['F', 52], ['M', 44], ['未知', 4]] as const),
      chance(rng, 0.92) ? new Date(START - int(rng, 18, 60) * 365 * DAY - int(rng, 0, 364) * DAY).toISOString().slice(0, 10) : null,
      dirty && chance(rng, 0.25) ? pick(rng, ['12345', '13800000000 ', '010-88886666', '']) : phone(rng),
      dirty && chance(rng, 0.3) ? pick(rng, ['not-an-email', 'a@b', name + '@', '']) : emailFor(name, i, rng),
      pick(rng, channels),
      chance(rng, 0.95) ? pick(rng, CITIES).id : null,
      weighted(rng, vipLevels),
      int(rng, 0, 50000),
      fmt(registered),
      chance(rng, 0.9) ? fmt(Math.min(NOW, registered + int(rng, 1, 400) * DAY)) : null,
      chance(rng, 0.03) ? 'frozen' : 'active',
      chance(rng, 0.55) ? 1 : 0,
    );
  }
  if (drift) {
    for (let i = 0; i < 25; i++) {
      insert.run(
        `C9${String(i).padStart(5, '0')}`,
        chineseName(rng),
        null,
        '未知',
        null,
        phone(rng),
        `mirror${i}@example.com`,
        '镜像补录',
        pick(rng, CITIES).id,
        '普通会员',
        0,
        fmt(NOW - int(rng, 1, 30) * DAY),
        null,
        'active',
        0,
      );
    }
  }

  const insertAddress = db.prepare('INSERT INTO customer_addresses (customer_id,receiver,phone,province,city,district,detail,postcode,is_default,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const districts = ['朝阳区', '海淀区', '浦东新区', '徐汇区', '天河区', '南山区', '武侯区', '西湖区', '鼓楼区', '和平区'];
  for (let i = 0; i < 5500; i++) {
    const customerId = 1 + int(rng, 0, 2999);
    const city = pick(rng, CITIES);
    insertAddress.run(
      customerId,
      chineseName(rng),
      phone(rng),
      city.province,
      city.name,
      pick(rng, districts),
      `${pick(rng, ['幸福路', '科技大道', '中山路', '人民广场', '滨江大道', '文化街'])}${int(rng, 1, 999)}号${int(rng, 1, 30)}栋${int(rng, 101, 2504)}室`,
      String(100000 + int(rng, 0, 899999)),
      i < 3000 ? 1 : 0,
      fmt(NOW - int(rng, 0, 900) * DAY),
    );
  }
}

function seedInventory(db: DatabaseSync, rng: Rng): void {
  const insert = db.prepare('INSERT INTO inventory (product_id,warehouse_id,qty,safety_qty,updated_at) VALUES (?,?,?,?,?)');
  for (let productId = 1; productId <= 600; productId++) {
    for (const warehouse of WAREHOUSES) {
      insert.run(productId, warehouse.id, chance(rng, 0.05) ? -int(rng, 1, 20) : int(rng, 0, 1500), int(rng, 20, 300), fmt(NOW - int(rng, 0, 30) * DAY));
    }
  }
}

function seedCoupons(db: DatabaseSync, rng: Rng): void {
  const insertCoupon = db.prepare('INSERT INTO coupons (code,name,type,threshold_cents,discount_cents,issued_at,expire_at,quota,used_count,status) VALUES (?,?,?,?,?,?,?,?,?,?)');
  for (let i = 1; i <= 120; i++) {
    const issued = START + int(rng, 0, 500) * DAY;
    const type = weighted(rng, [['满减', 55], ['折扣', 25], ['现金券', 15], ['赠品', 5]] as const);
    insertCoupon.run(
      `CP${String(i).padStart(4, '0')}`,
      `${pick(rng, ['618', '双11', '年货节', '会员日', '开业庆', '直播专享'])}${type}券`,
      type,
      int(rng, 0, 30000),
      int(rng, 500, 20000),
      fmt(issued),
      fmt(issued + int(rng, 7, 90) * DAY),
      int(rng, 100, 5000),
      int(rng, 0, 3000),
      chance(rng, 0.1) ? 'expired' : 'active',
    );
  }
}

function seedOrders(db: DatabaseSync, rng: Rng, drift: boolean): void {
  const dayWeights: number[] = [];
  for (let d = 0; d < 540; d++) {
    const day = new Date(dayStart(START) + d * DAY);
    const month = day.getUTCMonth() + 1;
    const date = day.getUTCDate();
    const weekday = day.getUTCDay();
    let weight = 1;
    if (month === 6 && date >= 15 && date <= 20) weight *= 4;
    if (month === 11 && date >= 8 && date <= 13) weight *= 6;
    if (month === 11 && date === 10) weight *= 2;
    if (month === 12 && date >= 10 && date <= 14) weight *= 2.4;
    if (month === 3 && date >= 6 && date <= 10) weight *= 2;
    if (weekday === 0 || weekday === 6) weight *= 1.35;
    if (date >= 28) weight *= 1.15;
    dayWeights.push(weight);
  }
  const cumulative: number[] = [];
  let runningTotal = 0;
  for (const weight of dayWeights) {
    runningTotal += weight;
    cumulative.push(runningTotal);
  }
  const pickDay = (): number => {
    const hit = rng() * runningTotal;
    let low = 0;
    let high = cumulative.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (cumulative[mid] < hit) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  const insertOrder = db.prepare(
    `INSERT INTO orders (order_no,customer_id,store_id,channel,status,payment_method,coupon_code,goods_${drift ? 'amount_' : ''}cents,freight_cents,discount_cents,pay_cents,points_used,created_at,paid_at,shipped_at,completed_at,delivery_date,remark,${drift ? 'sync_at' : 'invoice_title'},is_test_order)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insertItem = db.prepare('INSERT INTO order_items (order_id,product_id,variant,qty,unit_price_cents,discount_cents,refund_status) VALUES (?,?,?,?,?,?,?)');
  const insertPayment = db.prepare('INSERT INTO payments (payment_no,order_id,method,amount_cents,status,trade_no,gateway_fee_cents,paid_at) VALUES (?,?,?,?,?,?,?,?)');
  const insertRefund = db.prepare('INSERT INTO refunds (refund_no,order_id,order_item_id,amount_cents,reason,status,created_at,finished_at) VALUES (?,?,?,?,?,?,?,?)');
  const insertShipment = db.prepare('INSERT INTO shipments (shipment_no,order_id,warehouse_id,carrier,tracking_no,province,city,weight_kg,freight_cents,status,shipped_at,delivered_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const insertHistory = db.prepare('INSERT INTO order_status_history (order_id,from_status,to_status,changed_at,changed_by) VALUES (?,?,?,?,?)');
  const insertCouponRedemption = db.prepare('INSERT INTO coupon_redemptions (coupon_id,order_id,customer_id,discount_cents,redeemed_at) VALUES (?,?,?,?,?)');
  const reasons = ['七天无理由', '商品质量问题', '发错货', '物流破损', '不想要了', '价格保护'];
  const couponCodes: string[] = [];

  for (let i = 0; i < 120; i++) {
    couponCodes.push(`CP${String(i + 1).padStart(4, '0')}`);
  }

  const orderCount = drift ? 24500 : 25000;
  for (let i = 1; i <= 25000; i++) {
    if (drift && i % 50 === 0) continue; // 2% 行缺失
    const dayIndex = pickDay();
    const created = START + dayIndex * DAY + int(rng, 0, 86_399) * 1000;
    const ageDays = Math.floor((NOW - created) / DAY);
    let status: string;
    if (ageDays > 30) status = weighted(rng, [['completed', 86], ['refunded', 5], ['cancelled', 5], ['closed', 4]] as const);
    else if (ageDays > 7) status = weighted(rng, [['completed', 55], ['delivered', 18], ['shipped', 10], ['refunded', 8], ['cancelled', 5], ['closed', 4]] as const);
    else status = weighted(rng, [['pending', 26], ['paid', 24], ['shipped', 24], ['delivered', 10], ['completed', 10], ['cancelled', 4], ['refunded', 2]] as const);
    const paid = !['pending', 'cancelled'].includes(status);
    const shipped = ['shipped', 'delivered', 'completed', 'refunded'].includes(status);
    const completed = ['completed', 'refunded', 'closed'].includes(status);
    const customerId = 1 + Math.floor(Math.pow(rng(), 1.8) * 3000);
    const channel = weighted(rng, CHANNEL_WEIGHTS);
    const store = channel === '线下门店' ? STORES[int(rng, 0, STORES.length - 1)] : null;
    const discount = chance(rng, 0.32) ? int(rng, 500, 8000) : 0;
    const freight = 0;
    const itemCount = int(rng, 1, 4);
    const items: Array<{ productId: number; qty: number; price: number; discount: number; variant: string | null }> = [];
    let goods = 0;
    for (let k = 0; k < itemCount; k++) {
      const productId = 1 + int(rng, 0, 599);
      const priceRow = rng();
      const price = int(rng, 2900, 699900) + (priceRow < 0.1 ? 100000 : 0);
      const qty = int(rng, 1, 3);
      const itemDiscount = chance(rng, 0.15) ? int(rng, 200, 3000) : 0;
      goods += price * qty - itemDiscount;
      items.push({ productId, qty, price, discount: itemDiscount, variant: chance(rng, 0.4) ? pick(rng, ['曜石黑', '月光白', '升级版', '家庭装']) : null });
    }
    let pay = Math.max(0, goods - discount + freight);
    if (drift && i % 250 === 0) pay = Math.max(0, pay - 1500); // 0.4% 金额漂移
    const paidAt = paid ? created + int(rng, 60, 7200) * 1000 : null;
    const shippedAt = shipped && paidAt ? paidAt + int(rng, 2, 72) * 3_600_000 : null;
    const completedAt = completed && shippedAt ? shippedAt + int(rng, 2, 96) * 3_600_000 : null;
    const orderNo = `SO${new Date(created).toISOString().slice(0, 10).replace(/-/g, '')}${String(i).padStart(6, '0')}`;
    const couponCode = chance(rng, 0.18) ? pick(rng, couponCodes) : null;
    const result = insertOrder.run(
      orderNo,
      customerId,
      store ? store.id : null,
      channel,
      status,
      paid ? weighted(rng, PAY_METHODS) : null,
      couponCode,
      goods,
      freight,
      discount,
      pay,
      chance(rng, 0.25) ? int(rng, 100, 5000) : 0,
      fmt(created),
      paidAt ? fmt(paidAt) : null,
      shippedAt ? fmt(shippedAt) : null,
      completedAt ? fmt(completedAt) : null,
      chance(rng, 0.25) ? new Date(created + int(rng, 1, 7) * DAY).toISOString().slice(0, 10) : null,
      chance(rng, 0.12) ? pick(rng, ['请尽快发货', '需要开发票', '礼品包装', '工作日送达', '放快递柜']) : null,
      drift
        ? fmt(NOW - int(rng, 0, 5) * DAY)
        : chance(rng, 0.08)
          ? `${pick(rng, COMPANY_PREFIX)}${pick(rng, ['科技有限公司', '贸易有限公司', '实业股份有限公司'])}`
          : null,
      chance(rng, 0.01) ? 1 : 0,
    );
    const orderId = Number(result.lastInsertRowid);
    if (couponCode) {
      insertCouponRedemption.run(Number(couponCode.slice(2)), orderId, customerId, discount, fmt(created));
    }
    let itemId = 0;
    for (const item of items) {
      const itemResult = insertItem.run(orderId, item.productId, item.variant, item.qty, item.price, item.discount, status === 'refunded' && chance(rng, 0.5) ? 'refunded' : 'none');
      itemId = Number(itemResult.lastInsertRowid);
    }
    insertHistory.run(orderId, null, 'created', fmt(created), 'system');
    if (paidAt) insertHistory.run(orderId, 'pending', 'paid', fmt(paidAt), 'payment-gateway');
    if (shippedAt) insertHistory.run(orderId, 'paid', 'shipped', fmt(shippedAt), 'warehouse');
    if (completedAt) insertHistory.run(orderId, 'shipped', 'completed', fmt(completedAt), 'system');
    if (paidAt) {
      insertPayment.run(
        `PAY${orderNo.slice(2)}`,
        orderId,
        pick(rng, PAY_METHODS)[0],
        pay,
        'success',
        `T${Math.floor(rng() * 1e9).toString().padStart(9, '0')}`,
        Math.round(pay * 0.006),
        fmt(paidAt),
      );
    }
    if (status === 'refunded' || (status === 'completed' && chance(rng, 0.02))) {
      const refunded = Math.round(pay * (0.2 + rng() * 0.8));
      const refundAt = created + int(rng, 1, 30) * DAY;
      insertRefund.run(
        `RF${orderNo.slice(2)}`,
        orderId,
        itemId || null,
        refunded,
        pick(rng, reasons),
        weighted(rng, [['approved', 60], ['processing', 20], ['rejected', 20]] as const),
        fmt(refundAt),
        chance(rng, 0.7) ? fmt(refundAt + int(rng, 1, 10) * DAY) : null,
      );
    }
    if (shipped && shippedAt) {
      const city = CITIES.find((c) => c.id === (store ? store.cityId : pick(rng, CITIES).id)) ?? CITIES[0];
      const delivered = completed && completedAt;
      insertShipment.run(
        `SH${orderNo.slice(2)}`,
        orderId,
        1 + int(rng, 0, 9),
        pick(rng, CARRIERS),
        `${pick(rng, ['SF', 'ZT', 'YT', 'YD', 'JD', 'EMS'])}${Math.floor(rng() * 1e12).toString().padStart(12, '0')}`,
        city.province,
        city.name,
        Math.round((0.2 + rng() * 8) * 100) / 100,
        int(rng, 0, 2500),
        delivered ? '已签收' : '运输中',
        fmt(shippedAt),
        delivered && completedAt ? fmt(completedAt + int(rng, 1, 48) * 3_600_000) : null,
      );
    }
  }
  // 保证订单数在中途插入失败时也能被发现
  const actual = db.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number };
  if (!drift && actual.n !== 25000) throw new Error(`orders 行数异常: ${actual.n}`);
}

function seedMarketing(db: DatabaseSync, rng: Rng): void {
  const insertCampaign = db.prepare('INSERT INTO marketing_campaigns (name,channel,segment,budget_cents,start_at,end_at,owner_emp_id,status) VALUES (?,?,?,?,?,?,?,?)');
  const campaignIds: number[] = [];
  const campaignChannels = ['信息流广告', '直播带货', '短视频种草', '短信触达', '私域社群', '线下快闪'];
  const segments = ['新客', '高价值会员', '沉睡会员', '母婴人群', 'Z 世代', '企业客户'];
  for (let i = 1; i <= 90; i++) {
    const start = START + int(rng, 0, 480) * DAY;
    const result = insertCampaign.run(
      `${pick(rng, ['春季焕新', '暑期狂欢', '开学季', '双11预热', '年末冲刺', '会员回馈'])}第${i}期`,
      pick(rng, campaignChannels),
      pick(rng, segments),
      int(rng, 100000, 20000000),
      fmt(start),
      fmt(start + int(rng, 3, 30) * DAY),
      EMPLOYEES.length ? pick(rng, EMPLOYEES).id : null,
      weighted(rng, [['finished', 60], ['running', 20], ['planned', 12], ['cancelled', 8]] as const),
    );
    campaignIds.push(Number(result.lastInsertRowid));
  }
  const insertTouch = db.prepare('INSERT INTO campaign_touches (campaign_id,customer_id,touch_type,touched_at,clicked,converted,cost_cents) VALUES (?,?,?,?,?,?,?)');
  for (let i = 0; i < 24000; i++) {
    const clicked = chance(rng, 0.22);
    insertTouch.run(
      pick(rng, campaignIds),
      1 + int(rng, 0, 2999),
      weighted(rng, [['push', 40], ['sms', 25], ['ad', 25], ['call', 10]] as const),
      fmt(START + int(rng, 0, 520) * DAY + int(rng, 0, 86_399) * 1000),
      clicked ? 1 : 0,
      clicked && chance(rng, 0.12) ? 1 : 0,
      int(rng, 0, 500),
    );
  }
}

function seedSubscriptions(db: DatabaseSync, rng: Rng): void {
  const insert = db.prepare('INSERT INTO subscriptions (subscription_no,customer_id,plan,status,seats,mrr_cents,started_at,renews_at,cancelled_at,auto_renew,cancel_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for (let i = 1; i <= 3200; i++) {
    const [plan, price] = pick(rng, SUB_PLANS);
    const started = START + int(rng, 0, 520) * DAY;
    const cancelled = chance(rng, 0.18);
    const cancelsAt = cancelled ? started + int(rng, 30, 400) * DAY : null;
    const status = cancelled ? 'cancelled' : weighted(rng, [['active', 88], ['paused', 7], ['past_due', 5]] as const);
    insert.run(
      `SUB${String(i).padStart(6, '0')}`,
      1 + int(rng, 0, 2999),
      plan,
      status,
      int(rng, 1, 200),
      price * int(rng, 1, 20),
      fmt(started),
      status === 'active' ? fmt(Math.min(NOW + 30 * DAY, started + 365 * DAY)) : null,
      cancelsAt ? fmt(Math.min(NOW, cancelsAt)) : null,
      chance(rng, 0.7) ? 1 : 0,
      cancelled ? pick(rng, ['预算削减', '迁移其他平台', '功能不满足', '价格过高', '公司解散']) : null,
    );
  }
}

function seedFinance(db: DatabaseSync, rng: Rng): void {
  const insert = db.prepare('INSERT INTO finance_entries (entry_no,booked_at,account_code,account_name,summary,debit_cents,credit_cents,related_order_id,department_id,created_by_emp_id,currency) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const accounts: Array<[string, string]> = [['1001', '库存现金'], ['1002', '银行存款'], ['1122', '应收账款'], ['1405', '库存商品'], ['2202', '应付账款'], ['6001', '主营业务收入'], ['6401', '主营业务成本'], ['6601', '销售费用'], ['6602', '管理费用'], ['2221', '应交税费']];
  for (let i = 1; i <= 15000; i++) {
    const booked = new Date(START + int(rng, 0, 540) * DAY).toISOString().slice(0, 10);
    const [code, name] = pick(rng, accounts);
    const amount = int(rng, 1000, 5_000_000);
    const debit = chance(rng, 0.5);
    insert.run(
      `FV${booked.replace(/-/g, '')}${String(i).padStart(5, '0')}`,
      booked,
      code,
      name,
      pick(rng, ['销售收入确认', '采购入库', '支付供应商货款', '银行手续费', '员工报销', '计提税费', '退款支出']),
      debit ? amount : 0,
      debit ? 0 : amount,
      chance(rng, 0.4) ? int(rng, 1, 24000) : null,
      int(rng, 1, 12),
      EMPLOYEES.length ? pick(rng, EMPLOYEES).id : null,
      'CNY',
    );
  }
}

function seedSupport(db: DatabaseSync, rng: Rng): void {
  const insertTicket = db.prepare('INSERT INTO support_tickets (ticket_no,customer_id,order_id,category,priority,status,title,content,assignee_emp_id,csat,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const insertMessage = db.prepare('INSERT INTO ticket_messages (ticket_id,sender_type,sender_name,content,created_at) VALUES (?,?,?,?,?)');
  for (let i = 1; i <= 6000; i++) {
    const created = START + int(rng, 0, 538) * DAY + int(rng, 0, 86_399) * 1000;
    const status = weighted(rng, [['resolved', 70], ['closed', 12], ['open', 10], ['pending', 8]] as const);
    const category = pick(rng, TICKET_CATEGORIES);
    const orderId = chance(rng, 0.6) ? int(rng, 1, 24000) : null;
    const result = insertTicket.run(
      `TK${new Date(created).toISOString().slice(0, 10).replace(/-/g, '')}${String(i).padStart(5, '0')}`,
      1 + int(rng, 0, 2999),
      orderId,
      category,
      weighted(rng, TICKET_PRIORITIES),
      status,
      `${category}：${pick(rng, ['客户催办', '需要人工介入', '申请补偿', '信息核实', '重复咨询'])}`,
      `客户反馈：${pick(rng, ['物流三天没有更新', '商品与描述不符', '发票抬头开错', '账号无法登录', '重复扣款', '尺码不合适需要换货'])}，希望尽快处理。`,
      EMPLOYEES.length ? pick(rng, EMPLOYEES).id : null,
      status === 'resolved' && chance(rng, 0.5) ? int(rng, 1, 5) : null,
      fmt(created),
      fmt(created + int(rng, 1, 72) * 3_600_000),
    );
    const ticketId = Number(result.lastInsertRowid);
    const msgs = int(rng, 1, 4);
    for (let k = 0; k < msgs; k++) {
      const fromCustomer = k % 2 === 0;
      insertMessage.run(
        ticketId,
        fromCustomer ? 'customer' : 'agent',
        fromCustomer ? chineseName(rng) : `客服${int(rng, 1, 20)}`,
        fromCustomer ? pick(rng, ['麻烦尽快处理，谢谢。', '已经等了两天了。', '补充一下订单截图。', '还是没有人联系我。']) : pick(rng, ['您好，已为您登记，请耐心等待。', '已联系仓库核实。', '退款将在 1-3 个工作日到账。', '已为您补发。']),
        fmt(created + (k + 1) * int(rng, 10, 600) * 60_000),
      );
    }
  }
}

function seedWebAnalytics(db: DatabaseSync, rng: Rng): void {
  const insertEvent = db.prepare('INSERT INTO web_events (customer_id,session_id,event_type,page_path,referrer,device,os,app_version,city_id,occurred_at,duration_ms,payload) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const eventTypes: ReadonlyArray<readonly [string, number]> = [['page_view', 45], ['product_view', 25], ['add_to_cart', 10], ['checkout_start', 6], ['search', 7], ['pay_success', 4], ['app_launch', 3]];
  const pages = ['/home', '/category', '/product/detail', '/cart', '/checkout', '/order/list', '/search', '/member/center'];
  const referrers = ['https://www.baidu.com', 'https://www.google.com', 'https://weixin.qq.com', 'direct', 'https://www.douyin.com', ''];
  for (let i = 0; i < 60000; i++) {
    const occurred = START + int(rng, 0, 540) * DAY + int(rng, 0, 86_399) * 1000;
    const type = weighted(rng, eventTypes);
    insertEvent.run(
      chance(rng, 0.72) ? 1 + int(rng, 0, 2999) : chance(rng, 0.3) ? null : 9001 + int(rng, 0, 24),
      `sess_${Math.floor(rng() * 1e12).toString(36)}`,
      type,
      pick(rng, pages),
      pick(rng, referrers),
      pick(rng, ['ios', 'android', 'pc', 'h5']),
      pick(rng, ['iOS 18', 'Android 15', 'Windows 11', 'macOS 15', 'HarmonyOS NEXT']),
      `v${int(rng, 3, 6)}.${int(rng, 0, 12)}.${int(rng, 0, 9)}`,
      pick(rng, CITIES).id,
      fmt(occurred),
      type === 'page_view' || type === 'product_view' ? int(rng, 800, 180_000) : null,
      JSON.stringify({ source: pick(rng, ['organic', 'paid', 'social', 'direct']), utm: chance(rng, 0.4) ? `u_${int(rng, 1000, 9999)}` : null }),
    );
  }

  const insertDaily = db.prepare('INSERT INTO daily_metrics (metric_date,channel,gmv_cents,order_cnt,paid_order_cnt,refund_cnt,new_customer_cnt,uv,pv,cvr,aov_cents) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for (let d = 0; d < 540; d++) {
    const date = new Date(dayStart(START) + d * DAY).toISOString().slice(0, 10);
    for (const channel of ORDER_CHANNELS) {
      const orders = int(rng, 20, 160);
      const gmv = orders * int(rng, 15000, 60000);
      insertDaily.run(date, channel, gmv, orders, Math.round(orders * (0.8 + rng() * 0.15)), int(rng, 0, 12), int(rng, 2, 60), int(rng, 500, 9000), int(rng, 2000, 40000), Math.round((1 + rng() * 5) * 10000) / 10000, Math.round(gmv / Math.max(1, orders)));
    }
  }

  const insertProductStat = db.prepare('INSERT INTO product_daily_stats (stat_date,product_id,exposure,clicks,sales_cnt,sales_cents) VALUES (?,?,?,?,?,?)');
  for (let d = 0; d < 90; d++) {
    const date = new Date(dayStart(NOW - (89 - d) * DAY)).toISOString().slice(0, 10);
    for (let p = 1; p <= 200; p++) {
      const exposure = int(rng, 30, 9000);
      const clicks = Math.round(exposure * (0.02 + rng() * 0.18));
      const sales = Math.round(clicks * (0.01 + rng() * 0.12));
      insertProductStat.run(date, p, exposure, clicks, sales, sales * int(rng, 2900, 299900));
    }
  }
}

function seedMisc(db: DatabaseSync, rng: Rng, drift: boolean): void {
  if (!drift) {
    const insertReview = db.prepare('INSERT INTO product_reviews (product_id,customer_id,order_id,rating,content,has_image,helpful_count,created_at) VALUES (?,?,?,?,?,?,?,?)');
    const reviewTexts = ['质量不错，物流很快，会回购。', '包装精美，实物和描述一致。', '用了一周，整体满意。', '性价比很高，推荐。', '颜色有点色差，其他还好。', '客服响应及时，体验不错。', '第二次购买了，稳定。', '尺寸偏小，建议选大一码。', '发货速度快，第二天就到了。', ''];
    for (let i = 0; i < 20000; i++) {
      insertReview.run(
        1 + int(rng, 0, 599),
        1 + int(rng, 0, 2999),
        chance(rng, 0.6) ? int(rng, 1, 24000) : null,
        weighted(rng, [[5, 50], [4, 30], [3, 12], [2, 5], [1, 3]] as const),
        pick(rng, reviewTexts),
        chance(rng, 0.18) ? 1 : 0,
        int(rng, 0, 200),
        fmt(START + int(rng, 0, 540) * DAY + int(rng, 0, 86_399) * 1000),
      );
    }

    const insertAvatar = db.prepare('INSERT INTO customer_avatars (customer_id,content_type,data,width,height,size_bytes,uploaded_at) VALUES (?,?,?,?,?,?,?)');
    for (let i = 1; i <= 500; i++) {
      const size = int(rng, 512, 4096);
      const bytes = new Uint8Array(size);
      bytes[0] = 0xff;
      bytes[1] = 0xd8;
      bytes[2] = 0xff;
      bytes[3] = 0xe0;
      for (let k = 4; k < size; k++) bytes[k] = Math.floor(rng() * 256);
      insertAvatar.run(i, 'image/jpeg', bytes, pick(rng, [96, 128, 256, 512]), pick(rng, [96, 128, 256, 512]), size, fmt(NOW - int(rng, 0, 400) * DAY));
    }

    const insertLegacy = db.prepare('INSERT INTO legacy_order_export (order_no,customer,amount,created,status_cn,memo) VALUES (?,?,?,?,?,?)');
    const legacyStatus = ['已完成', '已取消', '待发货', '已退款', '已完成 ', '未知'];
    for (let i = 0; i < 3000; i++) {
      const amount = int(rng, 1000, 900000);
      insertLegacy.run(
        chance(rng, 0.1) ? `SO-${int(rng, 1000, 9999)}` : `SO2024${String(int(rng, 1, 12)).padStart(2, '0')}${String(i).padStart(6, '0')}`,
        chineseName(rng) + (chance(rng, 0.1) ? ' ' : ''),
        chance(rng, 0.15) ? `${Math.round(amount / 100).toLocaleString('en-US')}.00元` : (amount / 100).toFixed(2),
        chance(rng, 0.45) ? `2024/${int(rng, 1, 12)}/${int(rng, 1, 28)} ${int(rng, 0, 23)}:${String(int(rng, 0, 59)).padStart(2, '0')}` : `2024-${String(int(rng, 1, 12)).padStart(2, '0')}-${String(int(rng, 1, 28)).padStart(2, '0')}`,
        pick(rng, legacyStatus),
        chance(rng, 0.2) ? pick(rng, ['客户要求加急', '含运费 12 元', '手工补录', '重复导出']) : null,
      );
    }
  }

  const insertReserved = db.prepare('INSERT INTO "order" ("group","order","select","desc","user") VALUES (?,?,?,?,?)');
  for (let i = 1; i <= 400; i++) {
    insertReserved.run(`G${int(rng, 1, 20)}`, `ORD-${i}`, pick(rng, ['A', 'B', 'C']), pick(rng, ['优先级高', '优先级中', '优先级低']), `legacy_user_${int(rng, 1, 50)}`);
  }
}

export function ensureBusinessDemoDatabases(config: GatewayConfig, store: Store, options: BuildOptions = {}): ConnectionConfig[] {
  const source = join(config.demoDir, 'demo-retail.sqlite');
  const mirror = join(config.demoDir, 'demo-retail-mirror.sqlite');
  buildBusinessDemoDatabase(source, options);
  buildBusinessDemoDatabase(mirror, { ...options, drift: true });
  const normalizePath = (value?: string): string => (value ? normalize(value).replace(/\//g, '\\').toLowerCase() : '');
  const specs: Array<{ name: string; file: string; note: string; color: ConnectionColor }> = [
    { name: 'Demo · 零售业务库', file: source, note: '业务演示库：零售/电商/门店/供应链/财务/客服/订阅，34 张表 + 2 视图，含脏数据用于质量与比对验证。', color: 'cyan' },
    { name: 'Demo2 · 零售镜像库', file: mirror, note: '与业务库存在结构漂移与行级差异的镜像库，用于结构对比/同步、数据比对与迁移测试。', color: 'orange' },
  ];
  const out: ConnectionConfig[] = [];
  for (const spec of specs) {
    const existing = store.listConnections().find((c) => c.engine === 'sqlite' && normalizePath(c.database) === normalizePath(spec.file));
    if (existing) {
      out.push(existing);
      continue;
    }
    out.push(
      store.createConnection({
        name: spec.name,
        engine: 'sqlite',
        color: spec.color,
        environment: 'dev',
        groupName: '示例',
        database: spec.file,
        readonly: false,
        note: spec.note,
      }),
    );
  }
  return out;
}
