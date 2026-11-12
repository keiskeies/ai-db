#!/usr/bin/env node
/**
 * 在本地 MySQL 造一个「表详略分档」演示库 aidb_demo_shop（docs/20）。
 *
 * 建这个库的目的不是「有数据可看」，而是让五档各自都能被真实观察到，包括边界：
 *   - config 档：取值写表注释 / 只写列注释（兜底路径）/ 完全没有注释（诚实降级）
 *   - TEXT 列注释里的假枚举（不能被当成取值）、超过 3 列、超过 200 字符（都要被截掉）
 *   - 命名里没有字典词、只靠「被 ≥3 张表引用」判成 config 的维度表
 *   - bridge / cold（日志、按月份分区的备份）/ system（flyway_、qrtz_）
 * 只用新 schema，不碰库里已有的库。
 */
const API = process.env.AIDB_API ?? 'http://localhost:8787';
const TOKEN = process.env.AIDB_TOKEN ?? 'dev-token';
const CONNECTION_ID = process.env.AIDB_CONNECTION_ID;
const SCHEMA = process.env.AIDB_SCHEMA ?? 'aidb_demo_shop';

if (!CONNECTION_ID) {
  console.error('用法: AIDB_CONNECTION_ID=<本地 mysql 连接 id> node scripts/qa/seed-tier-demo.mjs');
  console.error('     （连接 id 从 GET /api/connections 取，凭据由网关自己存，脚本不经手密码）');
  process.exit(1);
}

// 确定性随机：同一个库重跑两次得到同样的数据，便于对比 /init 产物。
let seed = 20261111;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];
const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));

const DDL = [];
const DATA = [];

/** 建表小工具：自动补 created_at/updated_at，注释原样落到 COMMENT。 */
function table(ddl) {
  DDL.push(ddl.trim());
}
function insert(sql) {
  DATA.push(sql.trim());
}

// 维表先建：orders / stores / shipments 上有真实外键指向它，MySQL 要求被引用表先存在。
// 它同时是「命名里没有字典词、只靠被 ≥3 张表引用判成 config」的那张样本表。
table(`CREATE TABLE IF NOT EXISTS dim_zone (
  id INT PRIMARY KEY,
  zone_name VARCHAR(32) NOT NULL COMMENT '大区名',
  zone_code VARCHAR(8),
  sort_no INT
) COMMENT '大区维度表'`);

// ---------------------------------------------------------------- 活跃业务表
table(`CREATE TABLE IF NOT EXISTS users (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  phone VARCHAR(20) NOT NULL COMMENT '手机号',
  nickname VARCHAR(64) COMMENT '昵称',
  member_level TINYINT NOT NULL DEFAULT 0 COMMENT '会员等级 0=普通 1=银卡 2=金卡 3=黑卡',
  gender TINYINT COMMENT '性别 0=未知 1=男 2=女',
  city_id INT COMMENT '所在城市',
  register_channel TINYINT COMMENT '注册渠道 1=APP 2=小程序 3=门店 4=H5',
  created_at DATETIME NOT NULL,
  updated_at DATETIME,
  KEY idx_level (member_level)
) COMMENT '注册用户主表'`);

table(`CREATE TABLE IF NOT EXISTS stores (
  id INT PRIMARY KEY AUTO_INCREMENT,
  store_name VARCHAR(64) NOT NULL COMMENT '门店名称',
  zone_id INT COMMENT '所属大区',
  city_id INT,
  manager_id INT,
  open_date DATE,
  created_at DATETIME NOT NULL,
  CONSTRAINT fk_stores_zone FOREIGN KEY (zone_id) REFERENCES dim_zone (id)
) COMMENT '线下门店'`);

table(`CREATE TABLE IF NOT EXISTS products (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  sku_code VARCHAR(32) NOT NULL COMMENT '商品编码',
  title VARCHAR(200) NOT NULL COMMENT '商品标题',
  category_id BIGINT COMMENT '后台类目',
  brand_id BIGINT,
  price DECIMAL(10,2) NOT NULL COMMENT '售价（元）',
  cost_amount DECIMAL(10,2) COMMENT '成本（元）',
  stock_qty INT DEFAULT 0 COMMENT '可售库存',
  status TINYINT NOT NULL DEFAULT 1 COMMENT '上架状态 0=下架 1=在售 2=预售',
  remark TEXT COMMENT '上线记录 2020:已上线 2021:灰度 2023:改版',
  created_at DATETIME NOT NULL,
  updated_at DATETIME,
  KEY idx_category (category_id)
) COMMENT '商品 SPU'`);

table(`CREATE TABLE IF NOT EXISTS product_skus (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  product_id BIGINT NOT NULL COMMENT 'SPU',
  spec_text VARCHAR(100) COMMENT '规格描述，如 黑色/XL',
  sale_price DECIMAL(10,2),
  stock_qty INT DEFAULT 0,
  created_at DATETIME NOT NULL,
  CONSTRAINT fk_skus_product FOREIGN KEY (product_id) REFERENCES products (id)
) COMMENT '商品 SKU'`);

table(`CREATE TABLE IF NOT EXISTS orders (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_no VARCHAR(32) NOT NULL COMMENT '订单号',
  user_id BIGINT NOT NULL COMMENT '下单用户',
  status TINYINT NOT NULL COMMENT '订单状态，取值见 order_status_dict',
  pay_channel TINYINT COMMENT '支付渠道，取值见 pay_channel',
  total_amount DECIMAL(12,2) NOT NULL COMMENT '订单总额（元）',
  discount_amount DECIMAL(12,2) DEFAULT 0 COMMENT '优惠金额（元）',
  pay_amount DECIMAL(12,2) COMMENT '实付金额（元）',
  delivery_type TINYINT COMMENT '配送方式，取值见 delivery_type',
  store_id INT COMMENT '自提/核销门店',
  zone_id INT COMMENT '大区',
  remark VARCHAR(500),
  CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_orders_zone FOREIGN KEY (zone_id) REFERENCES dim_zone (id),
  CONSTRAINT fk_orders_store FOREIGN KEY (store_id) REFERENCES stores (id),
  created_at DATETIME NOT NULL COMMENT '下单时间',
  paid_at DATETIME COMMENT '支付时间',
  shipped_at DATETIME,
  updated_at DATETIME,
  KEY idx_user (user_id), KEY idx_status (status), KEY idx_created (created_at)
) COMMENT '订单主表：一行一张订单'`);

table(`CREATE TABLE IF NOT EXISTS order_items (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_id BIGINT NOT NULL COMMENT '订单',
  product_id BIGINT,
  sku_id BIGINT,
  qty INT NOT NULL COMMENT '数量',
  unit_price DECIMAL(10,2) COMMENT '成交单价',
  line_amount DECIMAL(12,2) COMMENT '行小计（元）',
  created_at DATETIME NOT NULL,
  CONSTRAINT fk_items_order FOREIGN KEY (order_id) REFERENCES orders (id)
) COMMENT '订单明细'`);

table(`CREATE TABLE IF NOT EXISTS payments (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_id BIGINT NOT NULL,
  trade_no VARCHAR(64) COMMENT '第三方流水号',
  channel TINYINT COMMENT '支付渠道',
  pay_amount DECIMAL(12,2) NOT NULL,
  paid_at DATETIME NOT NULL COMMENT '到账时间',
  created_at DATETIME NOT NULL,
  CONSTRAINT fk_payments_order FOREIGN KEY (order_id) REFERENCES orders (id)
) COMMENT '支付流水'`);

table(`CREATE TABLE IF NOT EXISTS refunds (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_id BIGINT NOT NULL,
  refund_amount DECIMAL(12,2) NOT NULL COMMENT '退款金额（元）',
  reason_code TINYINT COMMENT '退款原因，取值见 refund_reason',
  audit_status TINYINT COMMENT '审核状态 0=待审 1=通过 2=驳回',
  created_at DATETIME NOT NULL,
  finished_at DATETIME,
  CONSTRAINT fk_refunds_order FOREIGN KEY (order_id) REFERENCES orders (id)
) COMMENT '退款单'`);

table(`CREATE TABLE IF NOT EXISTS shipments (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_id BIGINT NOT NULL,
  carrier TINYINT COMMENT '承运商 1=顺丰 2=中通 3=圆通 4=自提',
  waybill_no VARCHAR(64),
  zone_id INT,
  shipped_at DATETIME,
  signed_at DATETIME COMMENT '签收时间',
  created_at DATETIME NOT NULL,
  CONSTRAINT fk_shipments_order FOREIGN KEY (order_id) REFERENCES orders (id),
  CONSTRAINT fk_shipments_zone FOREIGN KEY (zone_id) REFERENCES dim_zone (id)
) COMMENT '发货物流'`);

for (const [name, comment] of [
  ['carts', '购物车'],
  ['cart_items', '购物车明细'],
  ['customer_addresses', '收货地址'],
  ['inventory', '库存快照（按仓）'],
  ['stock_movements', '出入库流水'],
  ['support_tickets', '客服工单'],
  ['ticket_messages', '工单会话消息'],
  ['product_reviews', '商品评价'],
  ['employees', '员工'],
  ['categories', '后台类目树'],
  ['brands', '品牌'],
]) {
  table(`CREATE TABLE IF NOT EXISTS ${name} (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    ref_id BIGINT COMMENT '关联主键',
    name VARCHAR(120),
    amount DECIMAL(12,2),
    qty INT,
    status TINYINT DEFAULT 1,
    created_at DATETIME NOT NULL,
    updated_at DATETIME
  ) COMMENT '${comment}'`);
}

// ------------------------------------------------------------ 字典/配置（config）
// 取值写在**表注释**上：第一手描述，直接抽，不加列名前缀。
table(`CREATE TABLE IF NOT EXISTS pay_channel (
  code TINYINT PRIMARY KEY,
  name VARCHAR(32) NOT NULL COMMENT '渠道名称',
  enabled TINYINT DEFAULT 1
) COMMENT '支付渠道 0=余额 1=微信支付 2=支付宝 3=对公转账 4=云闪付'`);

// 取值只写在**列注释**上（表注释只有四个字）：走列注释兜底路径。
table(`CREATE TABLE IF NOT EXISTS order_status_dict (
  code TINYINT PRIMARY KEY,
  label VARCHAR(32) NOT NULL COMMENT '状态名',
  status TINYINT NOT NULL COMMENT '0-待支付 1-已支付 2-已发货 3-已签收 4-退款中 5-已退款 6-已取消',
  sort_no INT
) COMMENT '订单状态字典'`);

// 冒号写法 + 「为」字写法：抽取正则两种都要认。
table(`CREATE TABLE IF NOT EXISTS delivery_type (
  code TINYINT PRIMARY KEY,
  label VARCHAR(32),
  method TINYINT COMMENT '配送方式：1=快递配送 2=门店自提 3=同城闪送',
  fee_amount DECIMAL(8,2) COMMENT '基础运费（元）'
) COMMENT '配送方式'`);

table(`CREATE TABLE IF NOT EXISTS refund_reason (
  code TINYINT PRIMARY KEY,
  label VARCHAR(64) COMMENT '原因文案',
  reason TINYINT COMMENT '0=不想要了 1=拍错/多拍 2=质量问题 3=少发货 4=其他',
  need_upload TINYINT DEFAULT 0
) COMMENT '退款原因'`);

table(`CREATE TABLE IF NOT EXISTS currency_dict (
  code CHAR(3) PRIMARY KEY,
  name VARCHAR(32) COMMENT '币种名',
  symbol VARCHAR(4),
  precision_val TINYINT DEFAULT 2 COMMENT '小数位 0=无小数 2=两位 3=三位'
) COMMENT '币种'`);

table(`CREATE TABLE IF NOT EXISTS member_level_cfg (
  code TINYINT PRIMARY KEY COMMENT '等级值 1=银卡 2=金卡 3=黑卡',
  level_name VARCHAR(32),
  threshold_amount DECIMAL(12,2) COMMENT '升级门槛（元）',
  discount_rate DECIMAL(4,2) COMMENT '折扣率'
) COMMENT '会员等级配置'`);

// **诚实降级**的样本：命名像字典，但库里一个字注释都没写 → [dict] 只给名字。
table(`CREATE TABLE IF NOT EXISTS channel_source (
  code TINYINT PRIMARY KEY,
  name VARCHAR(32),
  enabled TINYINT DEFAULT 1
) ENGINE=InnoDB`);

// dim_zone 的建表语句在最前面（被外键引用），这里只留它的分档说明：
// 命名里没有字典词，只能靠「被 ≥3 张表引用 + 行数小 + 无业务时间列」判成 config。

// 边界一：可抽取值的列有 4 个 → 只挂前 3 列（GLOSS_COLUMNS）。
table(`CREATE TABLE IF NOT EXISTS sys_config_kv (
  id INT PRIMARY KEY,
  scope_flag TINYINT COMMENT '作用域 0=全局 1=租户 2=用户',
  value_type TINYINT COMMENT '值类型 0=字符串 1=数字 2=布尔 3=JSON',
  encrypt_flag TINYINT COMMENT '是否加密 0=明文 1=AES 2=RSA',
  hot_flag TINYINT COMMENT '是否热点 0=否 1=是',
  config_key VARCHAR(64),
  config_value VARCHAR(500)
) COMMENT '系统配置项'`);

// 边界二：单列取值很多（8 个值）→ 列注释兜底每列只抽 6 个（extractEnumGloss maxPairs）。
table(`CREATE TABLE IF NOT EXISTS long_gloss_dict (
  id INT PRIMARY KEY,
  biz_flag TINYINT COMMENT '0=草稿态待提交需人工复核后进入下一环节 1=已提交等待审核排队中且可能被驳回 2=审核通过可以执行 3=审核驳回需要重新填写 4=已执行完成归档 5=已作废不可再操作 6=系统挂起等待外部回调 7=外部回调超时自动终止流程',
  flag_name VARCHAR(32)
) COMMENT '超长取值说明样本'`);

// 边界三：3 列各带一大串取值 → 累计超 GLOSS_MAX_CHARS 时后面的列丢掉（整段不超限为止）。
table(`CREATE TABLE IF NOT EXISTS wide_gloss_dict (
  id INT PRIMARY KEY,
  flag_a TINYINT COMMENT '0=草稿态待提交需人工复核后进入下一环节 1=已提交等待审核排队中且可能被驳回 2=审核通过可以执行 3=审核驳回需要重新填写',
  flag_b TINYINT COMMENT '0=未开始一切就绪等待上游产出 1=进行中已经排上队正在跑 2=成功完成结果可消费 3=失败需要人工介入排查',
  flag_c TINYINT COMMENT '0=停用不再对外可见仅保留历史 1=启用对外正常可见可被选择 2=灰度只对白名单放开 3=归档只读不再变更',
  flag_name VARCHAR(32)
) COMMENT '三列取值样本'`);

// 边界四：TEXT 列注释里的「数字:词」不是取值域 → 必须**不**被抽成枚举（isEnumish 排除 TEXT）。
table(`CREATE TABLE IF NOT EXISTS enum_note_dict (
  id INT PRIMARY KEY,
  note TEXT COMMENT '上线记录 2020:已上线 2021:灰度 2023:改版',
  flag_name VARCHAR(32)
) COMMENT '自由文本备注样本'`);

table(`CREATE TABLE IF NOT EXISTS tax_rate_dict (
  id INT PRIMARY KEY,
  goods_type TINYINT COMMENT '货物类型 1=货物 2=服务 3=不动产',
  rate DECIMAL(5,4) COMMENT '税率',
  effective_date DATE
) COMMENT '税率表'`);

table(`CREATE TABLE IF NOT EXISTS carrier_dict (
  code TINYINT PRIMARY KEY,
  name VARCHAR(32) COMMENT '承运商名称',
  phone VARCHAR(20)
) COMMENT '承运商字典'`);

// ---------------------------------------------------------------- 桥接（bridge）
table(`CREATE TABLE IF NOT EXISTS roles (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  role_name VARCHAR(32) NOT NULL COMMENT '角色名',
  created_at DATETIME
) COMMENT '角色'`);
table(`CREATE TABLE IF NOT EXISTS perms (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  perm_name VARCHAR(64) COMMENT '权限点',
  created_at DATETIME
) COMMENT '权限点'`);
table(`CREATE TABLE IF NOT EXISTS tags (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tag_name VARCHAR(32) COMMENT '标签名',
  created_at DATETIME
) COMMENT '商品标签'`);
// 桥接表的判定信号是「出向外键 ≥1 + 非外键列 ≤1 + 无业务时间列」，所以必须真的建
// FOREIGN KEY 约束：只写 BIGINT 列的话 information_schema 里查不到引用关系，分档看不出来。
for (const [name, left, leftRef, right, rightRef, comment] of [
  ['user_role', 'user_id', 'users (id)', 'role_id', 'roles (id)', '用户-角色'],
  ['role_perm', 'role_id', 'roles (id)', 'perm_id', 'perms (id)', '角色-权限'],
  ['product_tag', 'product_id', 'products (id)', 'tag_id', 'tags (id)', '商品-标签'],
  ['store_staff', 'store_id', 'stores (id)', 'employee_id', 'employees (id)', '门店-员工'],
]) {
  const leftType = left === 'store_id' ? 'INT' : 'BIGINT';
  table(`CREATE TABLE IF NOT EXISTS ${name} (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    ${left} ${leftType} NOT NULL,
    ${right} BIGINT NOT NULL,
    UNIQUE KEY uk_pair (${left}, ${right}),
    CONSTRAINT fk_${name}_l FOREIGN KEY (${left}) REFERENCES ${leftRef},
    CONSTRAINT fk_${name}_r FOREIGN KEY (${right}) REFERENCES ${rightRef}
  ) COMMENT '${comment}'`);
}

// ---------------------------------------------------------------- 低频（cold）
table(`CREATE TABLE IF NOT EXISTS order_log (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  order_id BIGINT,
  action VARCHAR(32),
  detail VARCHAR(500),
  created_at DATETIME
) COMMENT '订单操作日志'`);

table(`CREATE TABLE IF NOT EXISTS login_history (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT,
  ip VARCHAR(45),
  ua VARCHAR(200),
  created_at DATETIME
) COMMENT '登录记录'`);

table(`CREATE TABLE IF NOT EXISTS audit_trail (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  actor VARCHAR(64),
  action VARCHAR(64),
  created_at DATETIME
) COMMENT '审计轨迹'`);

table(`CREATE TABLE IF NOT EXISTS api_call_log (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  path VARCHAR(200),
  cost_ms INT,
  created_at DATETIME
) COMMENT '接口调用日志'`);

table(`CREATE TABLE IF NOT EXISTS etl_history (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  job_name VARCHAR(64),
  row_count INT,
  created_at DATETIME
) COMMENT 'ETL 执行历史'`);

table(`CREATE TABLE IF NOT EXISTS orders_2023_backup (
  id BIGINT PRIMARY KEY,
  order_no VARCHAR(32),
  pay_amount DECIMAL(12,2)
) COMMENT '2023 订单归档'`);

for (const month of ['01', '02', '03']) {
  table(`CREATE TABLE IF NOT EXISTS orders_2024_${month} (
    id BIGINT PRIMARY KEY,
    order_no VARCHAR(32),
    pay_amount DECIMAL(12,2)
  ) COMMENT '2024-${month} 按月分区备份'`);
}

table(`CREATE TABLE IF NOT EXISTS tmp_fix_2024 (
  id BIGINT PRIMARY KEY,
  note VARCHAR(200)
) COMMENT '一次性修数临时表'`);

table(`CREATE TABLE IF NOT EXISTS small_lookup (
  id INT PRIMARY KEY,
  label VARCHAR(20)
)`);

// ---------------------------------------------------------------- 系统（system）
table(`CREATE TABLE IF NOT EXISTS flyway_schema_history (
  installed_rank INT PRIMARY KEY,
  version VARCHAR(20),
  description VARCHAR(100),
  installed_on DATETIME
)`);

table(`CREATE TABLE IF NOT EXISTS qrtz_triggers (
  trigger_name VARCHAR(200) PRIMARY KEY,
  trigger_state VARCHAR(16),
  next_fire_time BIGINT
)`);

// ------------------------------------------------------------------ 造数据
// 序列发生器：数字表交叉连接，比递归 CTE 稳（不受 cte_max_recursion_depth 限制）。
const SEQ = `(SELECT a.N + b.N*10 + c.N*100 + d.N*1000 + 1 AS n FROM
  (SELECT 0 N UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) a,
  (SELECT 0 N UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) b,
  (SELECT 0 N UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) c,
  (SELECT 0 N UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9) d)`;

insert(`INSERT IGNORE INTO pay_channel (code, name) SELECT 0,'余额' UNION ALL SELECT 1,'微信支付' UNION ALL SELECT 2,'支付宝' UNION ALL SELECT 3,'对公转账' UNION ALL SELECT 4,'云闪付'`);
insert(`INSERT IGNORE INTO order_status_dict (code, label, status, sort_no)
  SELECT 1,'待支付',0,1 UNION ALL SELECT 2,'已支付',1,2 UNION ALL SELECT 3,'已发货',2,3
  UNION ALL SELECT 4,'已签收',3,4 UNION ALL SELECT 5,'退款中',4,5 UNION ALL SELECT 6,'已退款',5,6 UNION ALL SELECT 7,'已取消',6,7`);
insert(`INSERT IGNORE INTO delivery_type (code, label, method, fee_amount)
  SELECT 1,'快递配送',1,8.00 UNION ALL SELECT 2,'门店自提',2,0.00 UNION ALL SELECT 3,'同城闪送',3,15.00`);
insert(`INSERT IGNORE INTO refund_reason (code, label, reason)
  SELECT 1,'不想要了',0 UNION ALL SELECT 2,'拍错/多拍',1 UNION ALL SELECT 3,'质量问题',2
  UNION ALL SELECT 4,'少发货',3 UNION ALL SELECT 5,'其他',4`);
insert(`INSERT IGNORE INTO dim_zone (id, zone_name, zone_code)
  SELECT 1,'华东','HD' UNION ALL SELECT 2,'华北','HB' UNION ALL SELECT 3,'华南','HN' UNION ALL SELECT 4,'西南','XN'`);
insert(`INSERT IGNORE INTO member_level_cfg (code, level_name, threshold_amount, discount_rate)
  SELECT 1,'银卡',1000.00,0.95 UNION ALL SELECT 2,'金卡',5000.00,0.90 UNION ALL SELECT 3,'黑卡',20000.00,0.85`);
insert(`INSERT IGNORE INTO currency_dict (code, name, symbol) SELECT 'CNY','人民币','¥' UNION ALL SELECT 'USD','美元','$'`);
// 桥接表的父表要有行，否则后面带外键的桥接数据会被 MySQL 拒掉。
insert(`INSERT IGNORE INTO roles (id, role_name) SELECT 1,'运营' UNION ALL SELECT 2,'客服' UNION ALL SELECT 3,'财务' UNION ALL SELECT 4,'仓库' UNION ALL SELECT 5,'管理员'`);
insert(`INSERT IGNORE INTO perms (id, perm_name) SELECT n, CONCAT('perm:', n) FROM ${SEQ} seq WHERE n <= 40`);
insert(`INSERT IGNORE INTO tags (id, tag_name) SELECT n, CONCAT('标签', n) FROM ${SEQ} seq WHERE n <= 20`);
insert(`INSERT IGNORE INTO employees (id, name, created_at) SELECT 100 + n, CONCAT('员工', n), NOW() FROM ${SEQ} seq WHERE n <= 200`);


insert(`INSERT IGNORE INTO users (phone, nickname, member_level, gender, city_id, register_channel, created_at)
  SELECT CONCAT('13', LPAD(n, 9, '0')), CONCAT('用户', n), ${'n % 4'}, n % 3, 1 + (n % 30), 1 + (n % 4),
         DATE_SUB(NOW(), INTERVAL (n % 400) DAY) FROM ${SEQ} seq WHERE n <= 3000`);
insert(`INSERT IGNORE INTO stores (store_name, zone_id, city_id, manager_id, open_date, created_at)
  SELECT CONCAT('门店', n), 1 + (n % 4), 1 + (n % 30), 100 + n, DATE_SUB(CURDATE(), INTERVAL n DAY), DATE_SUB(NOW(), INTERVAL n DAY) FROM ${SEQ} seq WHERE n <= 40`);
insert(`INSERT IGNORE INTO categories (name, created_at) SELECT CONCAT('类目', n), NOW() FROM ${SEQ} seq WHERE n <= 60`);
insert(`INSERT IGNORE INTO brands (name, created_at) SELECT CONCAT('品牌', n), NOW() FROM ${SEQ} seq WHERE n <= 80`);
insert(`INSERT IGNORE INTO products (sku_code, title, category_id, brand_id, price, cost_amount, stock_qty, status, created_at, updated_at)
  SELECT CONCAT('SKU', LPAD(n, 6, '0')), CONCAT('商品 ', n, ' 号 精选好物'), 1 + (n % 60), 1 + (n % 80),
         ROUND(9.9 + (n % 500) * 1.7, 2), ROUND(4.5 + (n % 500) * 0.9, 2), (n * 7) % 900, n % 3,
         DATE_SUB(NOW(), INTERVAL (n % 300) DAY), DATE_SUB(NOW(), INTERVAL (n % 30) DAY) FROM ${SEQ} seq WHERE n <= 1200`);
insert(`INSERT IGNORE INTO product_skus (product_id, spec_text, sale_price, stock_qty, created_at)
  SELECT p.id, CONCAT('规格', s.n), p.price + s.n * 5, (p.id * s.n) % 200, NOW()
  FROM products p JOIN ${SEQ} s ON s.n <= 3`);
insert(`INSERT IGNORE INTO orders (order_no, user_id, status, pay_channel, total_amount, discount_amount, pay_amount, delivery_type, store_id, zone_id, created_at, paid_at, shipped_at, updated_at)
  SELECT CONCAT('SO', DATE_FORMAT(DATE_SUB(NOW(), INTERVAL (n % 365) DAY), '%Y%m%d'), LPAD(n, 7, '0')),
         1 + (n % 3000), n % 7, n % 5,
         ROUND(20 + (n % 900) * 2.3, 2), ROUND((n % 50) * 0.5, 2), ROUND(20 + (n % 900) * 2.3 - (n % 50) * 0.5, 2),
         1 + (n % 3), 1 + (n % 40), 1 + (n % 4),
         DATE_SUB(NOW(), INTERVAL (n % 365) DAY),
         IF(n % 7 IN (0,6), NULL, DATE_SUB(NOW(), INTERVAL (n % 365) DAY)),
         IF(n % 7 IN (0,1,6), NULL, DATE_SUB(NOW(), INTERVAL (n % 300) DAY)),
         DATE_SUB(NOW(), INTERVAL (n % 100) DAY)
  FROM ${SEQ} seq WHERE n <= 20000`);
insert(`INSERT IGNORE INTO order_items (order_id, product_id, sku_id, qty, unit_price, line_amount, created_at)
  SELECT o.id, 1 + (o.id % 1200), 1 + (o.id % 3600), 1 + (o.id % 3), o.pay_amount, o.pay_amount, o.created_at
  FROM orders o JOIN ${SEQ} s ON s.n <= 2 WHERE o.id % 4 <> 0`);
insert(`INSERT IGNORE INTO payments (order_id, trade_no, channel, pay_amount, paid_at, created_at)
  SELECT o.id, CONCAT('TR', o.order_no), o.pay_channel, o.pay_amount, o.paid_at, o.created_at
  FROM orders o WHERE o.paid_at IS NOT NULL`);
insert(`INSERT IGNORE INTO refunds (order_id, refund_amount, reason_code, audit_status, created_at, finished_at)
  SELECT o.id, ROUND(o.pay_amount * 0.5, 2), 1 + (o.id % 5), o.id % 3, o.created_at, o.created_at
  FROM orders o WHERE o.status IN (4,5) AND o.id % 3 = 0`);
insert(`INSERT IGNORE INTO shipments (order_id, carrier, waybill_no, zone_id, shipped_at, signed_at, created_at)
  SELECT o.id, 1 + (o.id % 4), CONCAT('SF', LPAD(o.id, 12, '0')), o.zone_id, o.shipped_at, o.shipped_at, o.created_at
  FROM orders o WHERE o.shipped_at IS NOT NULL`);
insert(`INSERT IGNORE INTO user_role (user_id, role_id) SELECT 1 + (n % 3000), 1 + (n % 5) FROM ${SEQ} seq WHERE n <= 3000`);
insert(`INSERT IGNORE INTO role_perm (role_id, perm_id) SELECT 1 + (n % 5), 1 + (n % 40) FROM ${SEQ} seq WHERE n <= 200`);
insert(`INSERT IGNORE INTO product_tag (product_id, tag_id) SELECT 1 + (n % 1200), 1 + (n % 20) FROM ${SEQ} seq WHERE n <= 4000`);
insert(`INSERT IGNORE INTO store_staff (store_id, employee_id) SELECT 1 + (n % 40), 100 + (n % 200) FROM ${SEQ} seq WHERE n <= 600`);
insert(`INSERT IGNORE INTO order_log (order_id, action, detail, created_at)
  SELECT 1 + (n % 20000), ELT(1 + (n % 3), '创建', '支付', '发货'), CONCAT('明细', n), DATE_SUB(NOW(), INTERVAL (n % 400) DAY) FROM ${SEQ} seq WHERE n <= 60000`);
insert(`INSERT IGNORE INTO login_history (user_id, ip, ua, created_at)
  SELECT 1 + (n % 3000), CONCAT('10.0.', n % 256, '.', (n div 256) % 256), 'Mozilla/5.0', DATE_SUB(NOW(), INTERVAL (n % 90) DAY) FROM ${SEQ} seq WHERE n <= 40000`);
insert(`INSERT IGNORE INTO audit_trail (actor, action, created_at) SELECT CONCAT('admin', n % 5), CONCAT('act_', n % 20), DATE_SUB(NOW(), INTERVAL (n % 200) DAY) FROM ${SEQ} seq WHERE n <= 20000`);
insert(`INSERT IGNORE INTO api_call_log (path, cost_ms, created_at) SELECT CONCAT('/api/v1/x', n % 30), 5 + (n % 400), DATE_SUB(NOW(), INTERVAL (n % 60) DAY) FROM ${SEQ} seq WHERE n <= 50000`);
insert(`INSERT IGNORE INTO etl_history (job_name, row_count, created_at) SELECT CONCAT('job_', n % 12), n * 13, DATE_SUB(NOW(), INTERVAL (n % 90) DAY) FROM ${SEQ} seq WHERE n <= 900`);
insert(`INSERT IGNORE INTO orders_2023_backup (id, order_no, pay_amount) SELECT id, order_no, pay_amount FROM orders WHERE id <= 3000`);
insert(`INSERT IGNORE INTO orders_2024_01 (id, order_no, pay_amount) SELECT id, order_no, pay_amount FROM orders WHERE id % 9000 = 1`);
insert(`INSERT IGNORE INTO orders_2024_02 (id, order_no, pay_amount) SELECT id + 1000000, order_no, pay_amount FROM orders WHERE id % 9000 = 2`);
insert(`INSERT IGNORE INTO orders_2024_03 (id, order_no, pay_amount) SELECT id + 2000000, order_no, pay_amount FROM orders WHERE id % 9000 = 3`);
insert(`INSERT IGNORE INTO tmp_fix_2024 (id, note) SELECT n, 'fix' FROM ${SEQ} seq WHERE n <= 50`);
insert(`INSERT IGNORE INTO small_lookup (id, label) SELECT n, CONCAT('L', n) FROM ${SEQ} seq WHERE n <= 12`);
insert(`INSERT IGNORE INTO sys_config_kv (id, scope_flag, value_type, encrypt_flag, hot_flag, config_key)
  SELECT n, n % 3, n % 4, n % 3, n % 2, CONCAT('cfg.key.', n) FROM ${SEQ} seq WHERE n <= 120`);
insert(`INSERT IGNORE INTO dim_zone (id, zone_name, zone_code) SELECT 5 + n, CONCAT('新区', n), CONCAT('Z', n) FROM ${SEQ} seq WHERE n <= 10`);
insert(`INSERT IGNORE INTO channel_source (code, name) SELECT n, CONCAT('渠道', n) FROM ${SEQ} seq WHERE n <= 12`);
insert(`INSERT IGNORE INTO long_gloss_dict (id, biz_flag, flag_name) SELECT n, n % 8, CONCAT('F', n) FROM ${SEQ} seq WHERE n <= 8`);
insert(`INSERT IGNORE INTO enum_note_dict (id, note, flag_name) SELECT n, '上线记录 2020:已上线', CONCAT('B', n) FROM ${SEQ} seq WHERE n <= 6`);
insert(`INSERT IGNORE INTO tax_rate_dict (id, goods_type, rate, effective_date) SELECT n, 1 + (n % 3), 0.06 + (n % 3) * 0.07, CURDATE() FROM ${SEQ} seq WHERE n <= 9`);
insert(`INSERT IGNORE INTO carrier_dict (code, name, phone) SELECT 1,'顺丰','95338' UNION ALL SELECT 2,'中通','95311' UNION ALL SELECT 3,'圆通','95554' UNION ALL SELECT 4,'自提',NULL`);
insert(`INSERT IGNORE INTO flyway_schema_history (installed_rank, version, description, installed_on) SELECT 1,'1.0.0','init',NOW() UNION ALL SELECT 2,'1.0.1','add idx',NOW()`);

async function run(sql, label) {
  const res = await fetch(`${API}/api/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ connectionId: CONNECTION_ID, sql, allowMulti: true, limit: 100 }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${label} 失败 ${res.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

const BATCH = 6;
console.log(`目标：连接 ${CONNECTION_ID} → schema ${SCHEMA}`);
await run(`CREATE DATABASE IF NOT EXISTS \`${SCHEMA}\` CHARACTER SET utf8mb4`, 'create database');

const prelude = `SET SESSION sql_mode='NO_AUTO_VALUE_ON_ZERO'; SET NAMES utf8mb4;`;
for (let i = 0; i < DDL.length; i += BATCH) {
  const chunk = DDL.slice(i, i + BATCH)
    .map((s) => (s.includes('IF NOT EXISTS') ? s : s.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS')))
    .join(';\n') + ';';
  await run(`${prelude} USE \`${SCHEMA}\`; ${chunk}`, `DDL ${i + 1}-${Math.min(i + BATCH, DDL.length)}`);
  console.log(`  建表 ${Math.min(i + BATCH, DDL.length)}/${DDL.length}`);
}

const probe = await run(`SELECT COUNT(*) AS c FROM \`${SCHEMA}\`.orders`, 'probe');
const existingRows = Number(probe.batch.sets[0].rows[0]?.[0] ?? 0);
if (existingRows > 0 && !process.argv.includes('--force')) {
  console.log(`\norders 已有 ${existingRows} 行，跳过灌数（要重灌加 --force）`);
} else {
for (let i = 0; i < DATA.length; i += 3) {
  const chunk = DATA.slice(i, i + 3).join(';\n') + ';';
  await run(`${prelude} USE \`${SCHEMA}\`; ${chunk}`, `DATA ${i + 1}`);
  console.log(`  灌数 ${Math.min(i + 3, DATA.length)}/${DATA.length}`);
}
}

const check = await run(
  `SELECT table_name, table_comment, table_rows FROM information_schema.tables WHERE table_schema='${SCHEMA}' ORDER BY table_name LIMIT 200`,
  'verify',
);
const set = check.batch.sets[0];
console.log(`\n${SCHEMA}：${set.rows.length} 张表`);
for (const row of set.rows) console.log(`  ${String(row[0]).padEnd(22)} ${String(row[1] ?? '').padEnd(24)} ~${row[2]}`);
