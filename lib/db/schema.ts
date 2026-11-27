import { pgTable, text, timestamp, boolean, serial, integer, jsonb, numeric, unique, pgEnum, index, uniqueIndex, check, bigserial, bigint, uuid, primaryKey } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

// --- Better Auth required tables -------------------------------------------
// Column names are camelCase to match Better Auth's defaults. Do not rename.

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name'),
  email: text('email').notNull().unique(),
  emailVerified: boolean('emailVerified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
  updatedAt: timestamp('updatedAt').notNull().defaultNow(),
  role: text('role').default('user'),
  banned: boolean('banned').default(false),
  banReason: text('banReason'),
  banExpires: timestamp('banExpires'),
})

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expiresAt').notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
  updatedAt: timestamp('updatedAt').notNull().defaultNow(),
  ipAddress: text('ipAddress'),
  userAgent: text('userAgent'),
  userId: text('userId')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
})

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('accountId').notNull(),
  providerId: text('providerId').notNull(),
  userId: text('userId')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('accessToken'),
  refreshToken: text('refreshToken'),
  idToken: text('idToken'),
  accessTokenExpiresAt: timestamp('accessTokenExpiresAt'),
  refreshTokenExpiresAt: timestamp('refreshTokenExpiresAt'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
  updatedAt: timestamp('updatedAt').notNull().defaultNow(),
})

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expiresAt').notNull(),
  createdAt: timestamp('createdAt').defaultNow(),
  updatedAt: timestamp('updatedAt').defaultNow(),
})

// --- Master data tables ---

// Retailers (parties we sell to). The table was called "vendors" until migration 0002;
// real suppliers live in `suppliers`.
export const retailers = pgTable('retailers', {
  id:         text('id').primaryKey(),
  partyName:  text('partyName').notNull(),
  gst:        text('gst').notNull().default(''),
  phone:      text('phone').notNull().default(''),
  /** For bills sent by email (migration 0014); '' = none. */
  email:      text('email').notNull().default(''),
  address:    text('address').notNull().default(''),
  city:       text('city').notNull().default(''),
  area:       text('area').notNull().default(''),
  day:        text('day').notNull().default(''),
  salesman:   text('salesman').notNull().default(''),
  status:     text('status').notNull().default('active'),
  // Payments (migration 0017): how the party is billed, credit terms, early-payment discount.
  taxType:            text('taxType').$type<TaxType>().notNull().default('intra_state'),
  creditLimitPaise:   bigint('creditLimitPaise', { mode: 'number' }),
  creditDays:         integer('creditDays'),
  earlyPayDiscountBp: integer('earlyPayDiscountBp'),
  earlyPayDays:       integer('earlyPayDays'),
  // Retailer shop sign-in (migration 0015): phone + PIN (scrypt hash). A new PIN signs out old sessions.
  shopPhone:       text('shopPhone').notNull().default(''),
  shopPinHash:     text('shopPinHash').notNull().default(''),
  shopEnabled:     boolean('shopEnabled').notNull().default(false),
  shopPinSetAt:    timestamp('shopPinSetAt', { withTimezone: true }),
  shopFailedPins:  integer('shopFailedPins').notNull().default(0),
  shopLockedUntil: timestamp('shopLockedUntil', { withTimezone: true }),
  createdAt:  timestamp('createdAt').notNull().defaultNow(),
  updatedAt:  timestamp('updatedAt').notNull().defaultNow(),
}, (t) => [
  index('retailers_party_name_idx').on(t.partyName),
  uniqueIndex('retailers_shop_phone_key').on(t.shopPhone).where(sql`${t.shopPhone} <> ''`),
])

/** @deprecated The table holds retailers. Use `retailers`. */
export const vendors = retailers

export const suppliers = pgTable('suppliers', {
  id:               serial('id').primaryKey(),
  name:             text('name').notNull(),
  contactPerson:    text('contactPerson').notNull().default(''),
  phone:            text('phone').notNull().default(''),
  email:            text('email').notNull().default(''),
  gst:              text('gst').notNull().default(''),
  address:          text('address').notNull().default(''),
  city:             text('city').notNull().default(''),
  divisions:        text('divisions').array().notNull().default(sql`'{}'::text[]`),
  paymentTermsDays: integer('paymentTermsDays'),
  notes:            text('notes').notNull().default(''),
  status:           text('status').$type<'active' | 'inactive'>().notNull().default('active'),
  createdAt:        timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:        timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})

export type ReviewStatus = 'unverified' | 'approved' | 'needs_review'

// Article = manufacturer article code (SS0702B). artName ("SS-702") is its display / family name
// and may cover several codes (boys and children's versions of one design).
export const catalogArticles = pgTable('catalog_articles', {
  id:           serial('id').primaryKey(),
  artCode:      text('artCode').notNull().unique('catalog_articles_code_unique'),
  artName:      text('artName').notNull(),
  brand:        text('brand'),
  /** Unused: segment is never derived from the code. The final article list brings a Segment column. */
  segmentHint:  text('segmentHint'),
  active:       boolean('active').notNull().default(true),
  reviewStatus: text('reviewStatus').$type<ReviewStatus>().notNull().default('unverified'),
  source:       text('source').$type<'legacy' | 'import' | 'manual' | 'scan_dialog'>().notNull().default('import'),
  createdAt:    timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})

// VARIANTS: one row per article code + colour code (the table keeps its historical name
// "articles" because scans, SKUs and the stock ledger reference these ids).
// Never deleted once referenced; variants absent from the approved catalogue are retired
// (active = false, retiredAt set).
export const articles = pgTable('articles', {
  id:        serial('id').primaryKey(),
  artName:   text('artName').notNull().default(''),
  artCode:   text('artCode').notNull().default(''),
  color:     text('color').notNull().default(''),
  colorCode: text('colorCode').notNull().default(''),
  /** First and last size of the variant in size order (may wrap: 11 … 5 for children). SKUs are the source of truth. */
  maxSize:   text('maxSize').notNull().default(''),
  minSize:   text('minSize').notNull().default(''),
  // 'unverified' = imported, not yet reviewed (still usable); 'approved' = matches the approved
  // catalogue; 'needs_review' = usable, but the source had a conflict an admin must settle.
  reviewStatus: text('reviewStatus').$type<ReviewStatus>().notNull().default('unverified'),
  active:    boolean('active').notNull().default(true),
  source:    text('source').$type<'legacy' | 'import' | 'manual' | 'scan_dialog'>().notNull().default('legacy'),
  division:  text('division'),
  /** Gents, Ladies, Kids or Baby (from the article list; never derived from the code). Migration 0010. */
  segment:   text('segment'),
  /** HSN code for the bill (migration 0016); from Relaxo proforma invoices, editable in Master. '' = not known. */
  hsn:       text('hsn').notNull().default(''),
  catalogArticleId: integer('catalogArticleId').references(() => catalogArticles.id, { onDelete: 'restrict' }),
  retiredAt:     timestamp('retiredAt', { withTimezone: true }),
  retiredReason: text('retiredReason'),
}, (t) => [
  index('articles_art_name_idx').on(t.artName),
  index('articles_catalog_article_idx').on(t.catalogArticleId),
  uniqueIndex('articles_artCode_colorCode_unique')
    .on(sql`upper(regexp_replace(btrim(${t.artCode}), '\\s+', ' ', 'g'))`, sql`upper(regexp_replace(btrim(${t.colorCode}), '\\s+', ' ', 'g'))`)
    .where(sql`btrim(${t.artCode}) <> '' AND btrim(${t.colorCode}) <> ''`),
])

export const articleMrps = pgTable('article_mrps', {
  id: serial('id').primaryKey(),
  artCode: text('artCode').notNull(),
  mrp: numeric('mrp', { precision: 10, scale: 2 }).notNull(),
  /** Newest manufacture year*100+month seen at this MRP; latest MRP = newest first (migration 0015). */
  mfgYm: integer('mfgYm'),
  lastSeenAt: timestamp('lastSeenAt', { withTimezone: true }),
}, (t) => [
  unique('article_mrps_artCode_mrp_unique').on(t.artCode, t.mrp),
  check('article_mrps_artCode_normalized_check', sql`${t.artCode} = upper(btrim(${t.artCode}))`),
])

/**
 * Photos of an article colour for the retailer shop (migration 0013). The file is in Vercel Blob;
 * only its public link is stored. sortOrder 0 = main photo.
 */
export const articlePhotos = pgTable('article_photos', {
  id:        serial('id').primaryKey(),
  articleId: integer('articleId').notNull().references(() => articles.id, { onDelete: 'cascade' }),
  url:       text('url').notNull().unique('article_photos_url_unique'),
  pathname:  text('pathname').notNull(),
  width:     integer('width'),
  height:    integer('height'),
  bytes:     integer('bytes'),
  sortOrder: integer('sortOrder').notNull().default(0),
  createdBy: text('createdBy').references(() => user.id, { onDelete: 'set null' }),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('article_photos_article_idx').on(t.articleId, t.sortOrder),
])

export type ArticlePhoto = typeof articlePhotos.$inferSelect

export const articleScanLinks = pgTable('article_scan_links', {
  id: serial('id').primaryKey(),
  articleId: integer('articleId').notNull().references(() => articles.id, { onDelete: 'cascade' }),
  action: text('action').$type<'created' | 'linked'>().notNull(),
  rawQr: text('rawQr').notNull(),
  userName: text('userName').notNull().default(''),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
  userId: text('userId').references(() => user.id, { onDelete: 'set null' }),
  scanEventId: bigint('scanEventId', { mode: 'number' }),
})

export const articleColors = pgTable('article_colors', {
  id:          serial('id').primaryKey(),
  articleId:   integer('articleId').notNull().references(() => articles.id, { onDelete: 'cascade' }),
  colorName:   text('colorName').notNull(),
  colorHex:    text('colorHex'),
  createdAt:   timestamp('createdAt').notNull().defaultNow(),
})

// Each row is a SKU (article + colour + size). Ids are referenced by the stock ledger:
// deactivate rows, never delete or re-create them.
export const articleSizes = pgTable('article_sizes', {
  id:          serial('id').primaryKey(),
  articleId:   integer('articleId').notNull().references(() => articles.id, { onDelete: 'cascade' }),
  sizeLabel:   text('sizeLabel').notNull(),
  sortOrder:   integer('sortOrder').notNull().default(0),
  createdAt:   timestamp('createdAt').notNull().defaultNow(),
  active:      boolean('active').notNull().default(true),
}, (t) => [
  unique('article_sizes_article_size_unique').on(t.articleId, t.sizeLabel),
])

// Size ranges a variant was supplied with, kept as given (the SKUs are their expansion).
export const articleSizeRanges = pgTable('article_size_ranges', {
  id:            serial('id').primaryKey(),
  articleId:     integer('articleId').notNull().references(() => articles.id, { onDelete: 'cascade' }),
  minSize:       text('minSize').notNull(),
  maxSize:       text('maxSize').notNull(),
  sizes:         text('sizes').array().notNull(),
  active:        boolean('active').notNull().default(true),
  sourceBatchId: integer('sourceBatchId').references(() => catalogImportBatches.id, { onDelete: 'set null' }),
  createdAt:     timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('article_size_ranges_unique').on(t.articleId, t.minSize, t.maxSize)])

export const catalogImportBatches = pgTable('catalog_import_batches', {
  id:            serial('id').primaryKey(),
  source:        text('source').notNull(),
  fileName:      text('fileName').notNull(),
  fileSha256:    text('fileSha256').notNull(),
  sheetName:     text('sheetName').notNull(),
  rowCount:      integer('rowCount').notNull(),
  appliedBy:     text('appliedBy').references(() => user.id, { onDelete: 'set null' }),
  appliedByName: text('appliedByName').notNull().default(''),
  appliedAt:     timestamp('appliedAt', { withTimezone: true }).notNull().defaultNow(),
  summary:       jsonb('summary').notNull().default({}),
})

export const catalogSourceRows = pgTable('catalog_source_rows', {
  id:        bigserial('id', { mode: 'number' }).primaryKey(),
  batchId:   integer('batchId').notNull().references(() => catalogImportBatches.id, { onDelete: 'cascade' }),
  rowNumber: integer('rowNumber').notNull(),
  raw:       jsonb('raw').notNull(),
  artName:   text('artName').notNull().default(''),
  artCode:   text('artCode').notNull().default(''),
  color:     text('color').notNull().default(''),
  colorCode: text('colorCode').notNull().default(''),
  minSize:   text('minSize').notNull().default(''),
  maxSize:   text('maxSize').notNull().default(''),
  articleId: integer('articleId').references(() => articles.id, { onDelete: 'set null' }),
  outcome:   text('outcome').$type<'used' | 'duplicate' | 'rejected'>().notNull(),
}, (t) => [unique('catalog_source_rows_unique').on(t.batchId, t.rowNumber)])

export type CatalogReviewStatus = 'open' | 'resolved' | 'dismissed'

export const catalogReviewItems = pgTable('catalog_review_items', {
  id:           serial('id').primaryKey(),
  kind:         text('kind').notNull(),
  severity:     text('severity').$type<'info' | 'review' | 'error'>().notNull(),
  subjectKey:   text('subjectKey').notNull(),
  artCode:      text('artCode').notNull().default(''),
  colorCode:    text('colorCode'),
  articleId:    integer('articleId').references(() => articles.id, { onDelete: 'set null' }),
  message:      text('message').notNull(),
  details:      jsonb('details'),
  status:       text('status').$type<CatalogReviewStatus>().notNull().default('open'),
  firstBatchId: integer('firstBatchId').references(() => catalogImportBatches.id, { onDelete: 'set null' }),
  lastBatchId:  integer('lastBatchId').references(() => catalogImportBatches.id, { onDelete: 'set null' }),
  createdAt:    timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt:   timestamp('resolvedAt', { withTimezone: true }),
  resolvedBy:   text('resolvedBy').references(() => user.id, { onDelete: 'set null' }),
  resolution:   text('resolution'),
}, (t) => [unique('catalog_review_items_subject_unique').on(t.kind, t.subjectKey)])

export type Article    = typeof articles.$inferSelect
export type ArticleColor = typeof articleColors.$inferSelect
export type ArticleSize  = typeof articleSizes.$inferSelect

// --- App tables: Inventory Management ---

// Read-only since migration 0002: merged rows from the old scanner. New scans go to scan_events.
// entryType: 'scan' = camera/image scan, 'manual' = manually entered
export const legacyScans = pgTable('legacy_scans', {
  id: serial('id').primaryKey(),
  entryType: text('entryType').notNull().default('scan'), // 'scan' | 'manual'
  rawQrCode: text('rawQrCode'),  // All rawQrCodes that have been merged into this row (one per physical box scanned)
  boxCodes: jsonb('boxCodes').$type<string[]>().default([]),
  artNumber: text('artNumber'),
  colorNumber: text('colorNumber'),
  sizeNumber: text('sizeNumber'),
  division: text('division'),
  mrp: numeric('mrp'),
  mfgMonth: integer('mfgMonth'),
  mfgYear: integer('mfgYear'),
  scannedByName: text('scannedByName'),
  notes: text('notes'),
  quantity: integer('quantity').notNull().default(1),
  scannedAt: timestamp('scannedAt').notNull().defaultNow(),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
  updatedAt: timestamp('updatedAt').notNull().defaultNow(),
})

// Scan grouping flags — shared across all users, list displayed in scanner UI
export const flags = pgTable('flags', {
  id:        serial('id').primaryKey(),
  name:      text('name').notNull(),
  createdAt: timestamp('createdAt').notNull().defaultNow(),
}, (t) => [unique('flags_name_unique').on(t.name)])

// --- Order Management ---

export const orderStatusEnum = pgEnum('order_status', [
  'to_confirm', // retailer shop order waiting for staff (migration 0015); pickers never see it
  'pending',
  'assigned',
  'packed',
  'billed',
  'dispatched',
  'delivered',
  'cancelled',
])

export const orderItemStatusEnum = pgEnum('order_item_status', [
  'pending',
  'packed',
  'out_of_stock',
])

export const orders = pgTable('orders', {
  id:                serial('id').primaryKey(),
  orderNumber:       text('orderNumber').notNull().unique(),
  shopkeeperName:    text('shopkeeperName').notNull(),
  shopkeeperPhone:   text('shopkeeperPhone'),
  shopkeeperAddress: text('shopkeeperAddress'),
  salesmanId:        text('salesmanId').references(() => user.id, { onDelete: 'set null' }),
  pickerId:          text('pickerId').references(() => user.id, { onDelete: 'set null' }),
  billerId:          text('billerId').references(() => user.id, { onDelete: 'set null' }),
  dispatcherId:      text('dispatcherId').references(() => user.id, { onDelete: 'set null' }),
  retailerId:        text('retailerId').references(() => retailers.id, { onDelete: 'restrict' }),
  status:            orderStatusEnum('status').notNull().default('pending'),
  notes:             text('notes'),
  totalBundles:      integer('totalBundles'),
  deliveryAgentName: text('deliveryAgentName'),
  isEmergency:       boolean('isEmergency').notNull().default(false),
  /** Who placed it (migration 0015): staff, or a retailer in the shop. */
  source:            text('source').$type<'staff' | 'retailer'>().notNull().default('staff'),
  /** Official sale bill number, given when billed (migration 0016; lib/billing/bill-number.ts). */
  billNo:            text('billNo'),
  orderedAt:         timestamp('orderedAt').notNull().defaultNow(),
  packedAt:          timestamp('packedAt'),
  billedAt:          timestamp('billedAt'),
  dispatchedAt:      timestamp('dispatchedAt'),
  deliveredAt:       timestamp('deliveredAt'),
  createdAt:         timestamp('createdAt').notNull().defaultNow(),
  updatedAt:         timestamp('updatedAt').notNull().defaultNow(),
})

export const billLines = pgTable('bill_lines', {
  id:          serial('id').primaryKey(),
  orderId:     integer('orderId').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  artNumber:   text('artNumber').notNull(),
  mrp:         numeric('mrp', { precision: 10, scale: 2 }).notNull(),
  qty:         integer('qty').notNull(),
  /** HSN copied from the article when billed (migration 0016). */
  hsn:         text('hsn'),
  lineDiscPct: numeric('lineDiscPct', { precision: 5, scale: 2 }).notNull().default('30'),
  createdAt:   timestamp('createdAt').notNull().defaultNow(),
})

export const orderItems = pgTable('order_items', {
  id:               serial('id').primaryKey(),
  orderId:          integer('orderId').notNull().references(() => orders.id, { onDelete: 'cascade' }),
  artNumber:        text('artNumber').notNull(),
  colorNumber:      text('colorNumber'),
  sizeNumber:       text('sizeNumber'),
  /** Exact article code (SS0101S) when the name covers several codes. Migration 0011; NULL on older lines. */
  artCode:          text('artCode'),
  quantityOrdered:  integer('quantityOrdered').notNull().default(1),
  quantityPacked:   integer('quantityPacked').notNull().default(0),
  status:           orderItemStatusEnum('status').notNull().default('pending'),
  createdAt:        timestamp('createdAt').notNull().defaultNow(),
  updatedAt:        timestamp('updatedAt').notNull().defaultNow(),
})

export type BillLine    = typeof billLines.$inferSelect
export type NewBillLine = typeof billLines.$inferInsert

export type Order = typeof orders.$inferSelect
export type NewOrder = typeof orders.$inferInsert
export type OrderItem = typeof orderItems.$inferSelect
export type NewOrderItem = typeof orderItems.$inferInsert
export type OrderStatus = typeof orderStatusEnum.enumValues[number]
export type OrderItemStatus = typeof orderItemStatusEnum.enumValues[number]

// --- Size Sets (admin-defined size+quantity templates) ---

/** Counters for official document numbers (migration 0016). 'sale_bill' = sale bill number. */
export const documentSequences = pgTable('document_sequences', {
  name:          text('name').primaryKey(),
  prefix:        text('prefix').notNull().default(''),
  next:          bigint('next', { mode: 'number' }).notNull(),
  padding:       integer('padding').notNull().default(0),
  updatedAt:     timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
  updatedByName: text('updatedByName').notNull().default(''),
})

export const orderSets = pgTable('order_sets', {
  id:          serial('id').primaryKey(),
  name:        text('name').notNull(),
  // quantities: { [sizeLabel]: qty } — e.g. { "6": 1, "7": 2, "8": 2, "9": 2, "10": 1 }
  quantities:  jsonb('quantities').$type<Record<string, number>>().notNull().default({}),
  createdAt:   timestamp('createdAt').notNull().defaultNow(),
  updatedAt:   timestamp('updatedAt').notNull().defaultNow(),
}, (t) => [
  unique('order_sets_name_unique').on(t.name),
])

export type OrderSet    = typeof orderSets.$inferSelect
export type NewOrderSet = typeof orderSets.$inferInsert

// ── Inventory foundation (migration 0002) ────────────────────────────────────

export const auditEvents = pgTable('audit_events', {
  id:          bigserial('id', { mode: 'number' }).primaryKey(),
  occurredAt:  timestamp('occurredAt', { withTimezone: true }).notNull().defaultNow(),
  actorUserId: text('actorUserId').references(() => user.id, { onDelete: 'set null' }),
  actorName:   text('actorName').notNull().default(''),
  action:      text('action').notNull(),
  entityType:  text('entityType').notNull(),
  entityId:    text('entityId').notNull(),
  before:      jsonb('before'),
  after:       jsonb('after'),
  reason:      text('reason'),
  metadata:    jsonb('metadata'),
}, (t) => [
  index('audit_events_action_time_idx').on(t.action, t.occurredAt),
])

export const locations = pgTable('locations', {
  id:        serial('id').primaryKey(),
  code:      text('code').notNull().unique('locations_code_unique'),
  name:      text('name').notNull(),
  kind:      text('kind').$type<'warehouse' | 'section' | 'rack' | 'shelf' | 'zone'>().notNull(),
  parentId:  integer('parentId'),
  active:    boolean('active').notNull().default(true),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
})

export type ScanResolution = 'resolved' | 'missing_article' | 'missing_size'

export const scanEvents = pgTable('scan_events', {
  id:            bigserial('id', { mode: 'number' }).primaryKey(),
  clientEventId: uuid('clientEventId').notNull().unique('scan_events_client_event_unique'),
  purpose:       text('purpose').$type<'stocktake'>().notNull().default('stocktake'),
  entryType:     text('entryType').$type<'scan' | 'manual'>().notNull(),
  source:        text('source').$type<'app' | 'offline_sync' | 'legacy_import'>().notNull().default('app'),
  status:        text('status').$type<'active' | 'voided'>().notNull().default('active'),
  rawInput:      text('rawInput'),
  payload:       text('payload'),
  dedupeKey:     text('dedupeKey'),
  formatId:      text('formatId'),
  parserVersion: text('parserVersion'),
  parseStatus:   text('parseStatus').$type<'parsed' | 'partial' | 'manual'>(),
  parsed:        jsonb('parsed'),
  articleCode:   text('articleCode'),
  colourCode:    text('colourCode'),
  sizeLabel:     text('sizeLabel'),
  mrp:           numeric('mrp', { precision: 10, scale: 2 }),
  mfgMonth:      integer('mfgMonth'),
  mfgYear:       integer('mfgYear'),
  quantity:      integer('quantity').notNull().default(1),
  resolution:    text('resolution').$type<ScanResolution>().notNull(),
  articleId:     integer('articleId').references(() => articles.id, { onDelete: 'restrict' }),
  skuId:         integer('skuId').references(() => articleSizes.id, { onDelete: 'restrict' }),
  locationId:    integer('locationId').notNull().references(() => locations.id),
  flag:          text('flag'),
  notes:         text('notes'),
  userId:        text('userId').references(() => user.id, { onDelete: 'set null' }),
  userName:      text('userName').notNull().default(''),
  deviceAt:      timestamp('deviceAt', { withTimezone: true }),
  createdAt:     timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  voidedAt:      timestamp('voidedAt', { withTimezone: true }),
  voidedBy:      text('voidedBy').references(() => user.id, { onDelete: 'set null' }),
  voidReason:    text('voidReason'),
  legacyScanId:  integer('legacyScanId'),
  /** Stocktake session (rack count) the scan belongs to. Migration 0021. */
  sessionId:     integer('sessionId').references(() => stocktakeSessions.id),
})

export type ScanEvent = typeof scanEvents.$inferSelect

// --- Warehouse Scanner: racks and stocktake sessions (migration 0021) ---

/** Racks / areas counted in the Warehouse Scanner. Kept by admin and supervisor. */
export const racks = pgTable('racks', {
  id:        serial('id').primaryKey(),
  name:      text('name').notNull(),
  active:    boolean('active').notNull().default(true),
  sortOrder: integer('sortOrder').notNull().default(0),
  createdBy: text('createdBy').references(() => user.id, { onDelete: 'set null' }),
  createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})

/** One godown stocktake: everyone scanning joins the open one. At most one open (migration 0022). */
export const stocktakeSessions = pgTable('stocktake_sessions', {
  id:             serial('id').primaryKey(),
  /** Old per-rack counts only; one godown stocktake has none (migration 0022). */
  rackId:         integer('rackId').references(() => racks.id),
  status:         text('status').$type<'open' | 'finished'>().notNull().default('open'),
  startedBy:      text('startedBy').references(() => user.id, { onDelete: 'set null' }),
  startedByName:  text('startedByName').notNull().default(''),
  startedAt:      timestamp('startedAt', { withTimezone: true }).notNull().defaultNow(),
  finishedAt:     timestamp('finishedAt', { withTimezone: true }),
  finishedBy:     text('finishedBy').references(() => user.id, { onDelete: 'set null' }),
  finishedByName: text('finishedByName'),
  note:           text('note').notNull().default(''),
}, (t) => [
  // One open godown stocktake at a time (migration 0022).
  uniqueIndex('stocktake_sessions_one_open').on(t.status).where(sql`status = 'open'`),
])

export type Provenance = 'scanned' | 'unscanned' | 'carton'
export type MovementType =
  | 'stocktake_scan' | 'stocktake_manual' | 'stocktake_carton' | 'legacy_import' | 'adjustment' | 'reversal'
  | 'transfer' | 'provenance_transfer' | 'receipt' | 'dispatch' | 'return'

// Append-only. stock_balances is maintained from this table by a database trigger.
export const stockMovements = pgTable('stock_movements', {
  id:             bigserial('id', { mode: 'number' }).primaryKey(),
  skuId:          integer('skuId').notNull().references(() => articleSizes.id, { onDelete: 'restrict' }),
  locationId:     integer('locationId').notNull().references(() => locations.id),
  provenance:     text('provenance').$type<Provenance>().notNull(),
  quantity:       integer('quantity').notNull(),
  movementType:   text('movementType').$type<MovementType>().notNull(),
  sourceType:     text('sourceType').notNull(),
  sourceId:       text('sourceId').notNull(),
  idempotencyKey: text('idempotencyKey').notNull().unique('stock_movements_idempotency_unique'),
  reversalOfId:   bigint('reversalOfId', { mode: 'number' }),
  userId:         text('userId').references(() => user.id, { onDelete: 'set null' }),
  reason:         text('reason'),
  createdAt:      timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
})

// Read-only from the application: written only by the stock_movements trigger.
export const stockBalances = pgTable('stock_balances', {
  skuId:      integer('skuId').notNull().references(() => articleSizes.id),
  locationId: integer('locationId').notNull().references(() => locations.id),
  provenance: text('provenance').$type<Provenance>().notNull(),
  quantity:   integer('quantity').notNull().default(0),
  updatedAt:  timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.skuId, t.locationId, t.provenance] })])

export const missingArticleReviews = pgTable('missing_article_reviews', {
  articleCode: text('articleCode').notNull(),
  colourCode:  text('colourCode').notNull(),
  status:      text('status').$type<'open' | 'ignored'>().notNull().default('open'),
  note:        text('note').notNull().default(''),
  updatedBy:   text('updatedBy').references(() => user.id, { onDelete: 'set null' }),
  updatedAt:   timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.articleCode, t.colourCode] })])

// --- Carton assortments (migration 0005) ---
// Pairs per size inside one carton, per division + segment + pairs per carton + assortment code.
// Versioned: an edit retires the active row and inserts the next version. Never deleted.
export interface AssortmentSize { size: string; pairs: number }

export const cartonAssortments = pgTable('carton_assortments', {
  id:            serial('id').primaryKey(),
  division:      text('division').notNull(),
  segment:       text('segment').notNull(),
  packing:       integer('packing').notNull(),
  code:          text('code').notNull(),
  sizes:         jsonb('sizes').$type<AssortmentSize[]>().notNull(),
  version:       integer('version').notNull().default(1),
  active:        boolean('active').notNull().default(true),
  note:          text('note').notNull().default(''),
  /** Article codes this assortment is only for (sorted, comma-separated); '' = any article. Migration 0012. */
  onlyFor:       text('onlyFor').notNull().default(''),
  source:        text('source').$type<'manual' | 'upload'>().notNull().default('manual'),
  sourceFile:    text('sourceFile'),
  createdBy:     text('createdBy').references(() => user.id, { onDelete: 'set null' }),
  createdAt:     timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  retiredAt:     timestamp('retiredAt', { withTimezone: true }),
  retiredBy:     text('retiredBy').references(() => user.id, { onDelete: 'set null' }),
  retiredReason: text('retiredReason'),
  replacedById:  integer('replacedById'),
}, (t) => [
  uniqueIndex('carton_assortments_active_key').on(t.division, t.segment, t.packing, t.code, t.onlyFor).where(sql`active`),
  uniqueIndex('carton_assortments_version_key').on(t.division, t.segment, t.packing, t.code, t.onlyFor, t.version),
])

// --- Billing takes stock out (migration 0006) ---

/** A box added by hand (no QR). Size and colour are optional (owner, 28 Nov 2026); kept on the draft row. */
export interface DraftManualLine { artNumber: string; mrp: number; qty: number; size?: string; colour?: string }

/** A Direct Bill from its first scan until it is generated or discarded. */
export const directBillDrafts = pgTable('direct_bill_drafts', {
  id:                serial('id').primaryKey(),
  status:            text('status').$type<'open' | 'billed' | 'discarded'>().notNull().default('open'),
  billerId:          text('billerId').references(() => user.id, { onDelete: 'set null' }),
  billerName:        text('billerName').notNull().default(''),
  shopkeeperName:    text('shopkeeperName').notNull().default(''),
  shopkeeperPhone:   text('shopkeeperPhone'),
  shopkeeperAddress: text('shopkeeperAddress'),
  lineDiscPct:       numeric('lineDiscPct', { precision: 5, scale: 2 }).notNull().default('30'),
  manualLines:       jsonb('manualLines').$type<DraftManualLine[]>().notNull().default([]),
  orderId:           integer('orderId').references(() => orders.id, { onDelete: 'set null' }),
  createdAt:         timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:         timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
  closedAt:          timestamp('closedAt', { withTimezone: true }),
})

export type BillStockSource = 'scanned' | 'carton' | 'unscanned' | 'unscanned_dispatch'

/** One physical box on a bill. A box can be on one active bill only. */
export const billScans = pgTable('bill_scans', {
  id:               bigserial('id', { mode: 'number' }).primaryKey(),
  clientEventId:    uuid('clientEventId').notNull().unique(),
  draftId:          integer('draftId').references(() => directBillDrafts.id),
  orderId:          integer('orderId').references(() => orders.id, { onDelete: 'restrict' }),
  orderNumber:      text('orderNumber'),
  rawInput:         text('rawInput').notNull(),
  dedupeKey:        text('dedupeKey').notNull(),
  articleCode:      text('articleCode'),
  colourCode:       text('colourCode'),
  sizeLabel:        text('sizeLabel'),
  mrp:              numeric('mrp', { precision: 10, scale: 2 }),
  skuId:            integer('skuId').references(() => articleSizes.id, { onDelete: 'restrict' }),
  stockSource:      text('stockSource').$type<BillStockSource>(),
  stockScanEventId: bigint('stockScanEventId', { mode: 'number' }).references(() => scanEvents.id),
  movementId:       bigint('movementId', { mode: 'number' }).references(() => stockMovements.id),
  status:           text('status').$type<'active' | 'released'>().notNull().default('active'),
  userId:           text('userId').references(() => user.id, { onDelete: 'set null' }),
  userName:         text('userName').notNull().default(''),
  createdAt:        timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  postedAt:         timestamp('postedAt', { withTimezone: true }),
  releasedAt:       timestamp('releasedAt', { withTimezone: true }),
  releasedReason:   text('releasedReason'),
}, (t) => [
  uniqueIndex('bill_scans_active_box').on(t.dedupeKey).where(sql`status = 'active'`),
])

// --- Purchases: expected stock, carton receiving (migration 0007) ---

export type PurchaseBillStatus = 'expected' | 'partial' | 'received' | 'cancelled'

export const purchaseBills = pgTable('purchase_bills', {
  id:             serial('id').primaryKey(),
  supplier:       text('supplier').notNull().default('Relaxo Footwears Limited'),
  docType:        text('docType').$type<'proforma' | 'invoice'>().notNull().default('proforma'),
  refNo:          text('refNo').notNull(),
  invoiceNo:      text('invoiceNo').notNull().default(''),
  billDate:       text('billDate').notNull(),
  soNo:           text('soNo'),
  soDate:         text('soDate'),
  poNo:           text('poNo'),
  customerCode:   text('customerCode'),
  division:       text('division').notNull().default(''),
  expectedOn:     text('expectedOn').notNull(),
  totalCartons:   integer('totalCartons').notNull(),
  totalPairs:     integer('totalPairs').notNull(),
  grossAmount:    numeric('grossAmount', { precision: 12, scale: 2 }),
  status:         text('status').$type<PurchaseBillStatus>().notNull().default('expected'),
  source:         text('source').$type<'upload' | 'mail'>().notNull().default('upload'),
  fileName:       text('fileName'),
  fileSha256:     text('fileSha256').notNull(),
  uploadedBy:     text('uploadedBy').references(() => user.id, { onDelete: 'set null' }),
  uploadedByName: text('uploadedByName').notNull().default(''),
  createdAt:      timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  receivedAt:     timestamp('receivedAt', { withTimezone: true }),
  cancelledAt:    timestamp('cancelledAt', { withTimezone: true }),
  cancelReason:   text('cancelReason'),
}, (t) => [
  uniqueIndex('purchase_bills_ref_unique').on(t.refNo),
  uniqueIndex('purchase_bills_file_unique').on(t.fileSha256),
])

export const purchaseBillLines = pgTable('purchase_bill_lines', {
  id:             serial('id').primaryKey(),
  billId:         integer('billId').notNull().references(() => purchaseBills.id, { onDelete: 'restrict' }),
  lineNo:         integer('lineNo').notNull(),
  hsn:            text('hsn'),
  articleCode:    text('articleCode').notNull(),
  colourCode:     text('colourCode').notNull(),
  sizeFrom:       text('sizeFrom').notNull(),
  sizeTo:         text('sizeTo').notNull(),
  packLetter:     text('packLetter').notNull().default(''),
  description:    text('description').notNull().default(''),
  cartons:        integer('cartons').notNull(),
  pairsPerCarton: integer('pairsPerCarton').notNull(),
  pairs:          integer('pairs').notNull(),
  mrp:            numeric('mrp', { precision: 10, scale: 2 }).notNull(),
  rate:           numeric('rate', { precision: 10, scale: 2 }),
  amount:         numeric('amount', { precision: 12, scale: 2 }),
  assortmentId:   integer('assortmentId').references(() => cartonAssortments.id),
})

export const cartonReceipts = pgTable('carton_receipts', {
  id:            bigserial('id', { mode: 'number' }).primaryKey(),
  clientEventId: uuid('clientEventId').notNull().unique(),
  rawInput:      text('rawInput').notNull(),
  dedupeKey:     text('dedupeKey').notNull(),
  articleCode:   text('articleCode').notNull(),
  colourCode:    text('colourCode').notNull(),
  sizeFrom:      text('sizeFrom').notNull(),
  sizeTo:        text('sizeTo').notNull(),
  packLetter:    text('packLetter').notNull().default(''),
  mrp:           numeric('mrp', { precision: 10, scale: 2 }),
  match:         text('match').$type<'matched' | 'unexpected' | 'stocktake'>().notNull(),
  /** Rack name of a stocktake carton. Migration 0021. */
  flag:          text('flag'),
  sessionId:     integer('sessionId').references(() => stocktakeSessions.id),
  billId:        integer('billId').references(() => purchaseBills.id),
  billLineId:    integer('billLineId').references(() => purchaseBillLines.id),
  assortmentId:  integer('assortmentId').references(() => cartonAssortments.id),
  postedAt:      timestamp('postedAt', { withTimezone: true }),
  postedPairs:   integer('postedPairs'),
  status:        text('status').$type<'active' | 'voided'>().notNull().default('active'),
  userId:        text('userId').references(() => user.id, { onDelete: 'set null' }),
  userName:      text('userName').notNull().default(''),
  createdAt:     timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
  voidedAt:      timestamp('voidedAt', { withTimezone: true }),
  voidedBy:      text('voidedBy').references(() => user.id, { onDelete: 'set null' }),
  voidReason:    text('voidReason'),
}, (t) => [
  uniqueIndex('carton_receipts_active_label').on(t.dedupeKey).where(sql`status = 'active'`),
])

// --- Payments: party ledger (migration 0017; docs/architecture/payments.md) ---

/** Within the state (CGST + SGST), outside the state (IGST), or no GST. */
export type TaxType = 'intra_state' | 'inter_state' | 'untaxed'

/** Frozen amounts of a sale bill. Amounts never change; only active → cancelled. */
export const saleBills = pgTable('sale_bills', {
  id:              bigserial('id', { mode: 'number' }).primaryKey(),
  orderId:         integer('orderId').notNull().references(() => orders.id, { onDelete: 'restrict' }),
  retailerId:      text('retailerId').references(() => retailers.id, { onDelete: 'restrict' }),
  customerName:    text('customerName').notNull().default(''),
  customerPhone:   text('customerPhone').notNull().default(''),
  paidMode:        text('paidMode').$type<'cash' | 'upi'>(),
  billNo:          text('billNo').notNull(),
  billDate:        text('billDate').notNull(), // date, YYYY-MM-DD (IST)
  billedAt:        timestamp('billedAt', { withTimezone: true }).notNull().defaultNow(),
  source:          text('source').$type<'invoice' | 'direct' | 'backfill'>().notNull(),
  taxType:         text('taxType').$type<TaxType>().notNull(),
  totalQty:        integer('totalQty').notNull(),
  lineDiscPct:     numeric('lineDiscPct', { precision: 5, scale: 2 }).notNull(),
  grossPaise:      bigint('grossPaise', { mode: 'number' }).notNull(),
  discountPct:     numeric('discountPct', { precision: 5, scale: 2 }).notNull(),
  discountPaise:   bigint('discountPaise', { mode: 'number' }).notNull(),
  taxablePaise:    bigint('taxablePaise', { mode: 'number' }).notNull(),
  cgstPct:         numeric('cgstPct', { precision: 5, scale: 2 }).notNull().default('0'),
  cgstPaise:       bigint('cgstPaise', { mode: 'number' }).notNull().default(0),
  sgstPct:         numeric('sgstPct', { precision: 5, scale: 2 }).notNull().default('0'),
  sgstPaise:       bigint('sgstPaise', { mode: 'number' }).notNull().default(0),
  igstPct:         numeric('igstPct', { precision: 5, scale: 2 }).notNull().default('0'),
  igstPaise:       bigint('igstPaise', { mode: 'number' }).notNull().default(0),
  roundOffPaise:   integer('roundOffPaise').notNull().default(0),
  grandTotalPaise: bigint('grandTotalPaise', { mode: 'number' }).notNull(),
  status:          text('status').$type<'active' | 'cancelled'>().notNull().default('active'),
  cancelledAt:     timestamp('cancelledAt', { withTimezone: true }),
  cancelledBy:     text('cancelledBy').references(() => user.id, { onDelete: 'set null' }),
  cancelReason:    text('cancelReason'),
  createdBy:       text('createdBy').references(() => user.id, { onDelete: 'set null' }),
  createdByName:   text('createdByName').notNull().default(''),
  createdAt:       timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
})

export type PaymentMode = 'cash' | 'upi' | 'cheque' | 'bank'
export type PaymentStatus = 'pending' | 'active' | 'returned' | 'bounced' | 'reversed'

/** Money received. A cheque is 'pending' (in hand, not counted) until deposited. */
export const payments = pgTable('payments', {
  id:             bigserial('id', { mode: 'number' }).primaryKey(),
  clientId:       uuid('clientId').notNull().unique(),
  receiptNo:      text('receiptNo').notNull().unique(),
  retailerId:     text('retailerId').notNull().references(() => retailers.id, { onDelete: 'restrict' }),
  receivedOn:     text('receivedOn').notNull(),
  countedOn:      text('countedOn'),
  mode:           text('mode').$type<PaymentMode>().notNull(),
  amountPaise:    bigint('amountPaise', { mode: 'number' }).notNull(),
  chequeNo:       text('chequeNo').notNull().default(''),
  chequeBank:     text('chequeBank').notNull().default(''),
  chequeDate:     text('chequeDate'),
  reference:      text('reference').notNull().default(''),
  note:           text('note').notNull().default(''),
  source:         text('source').$type<'office' | 'salesman'>().notNull().default('office'),
  collectedBy:    text('collectedBy').references(() => user.id, { onDelete: 'set null' }),
  status:         text('status').$type<PaymentStatus>().notNull().default('active'),
  countedBy:      text('countedBy').references(() => user.id, { onDelete: 'set null' }),
  countedByName:  text('countedByName').notNull().default(''),
  reversedAt:     timestamp('reversedAt', { withTimezone: true }),
  reversedBy:     text('reversedBy').references(() => user.id, { onDelete: 'set null' }),
  reversedByName: text('reversedByName').notNull().default(''),
  reversalReason: text('reversalReason'),
  createdBy:      text('createdBy').references(() => user.id, { onDelete: 'set null' }),
  createdByName:  text('createdByName').notNull().default(''),
  createdAt:      timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
})

export type LedgerKind = 'opening' | 'bill' | 'payment' | 'charge' | 'discount' | 'adjustment' | 'reversal'

/** Append-only. + = the party owes more, − = owes less. party_balances is kept by a trigger. */
export const partyLedgerEntries = pgTable('party_ledger_entries', {
  id:             bigserial('id', { mode: 'number' }).primaryKey(),
  retailerId:     text('retailerId').notNull().references(() => retailers.id, { onDelete: 'restrict' }),
  kind:           text('kind').$type<LedgerKind>().notNull(),
  amountPaise:    bigint('amountPaise', { mode: 'number' }).notNull(),
  entryDate:      text('entryDate').notNull(),
  saleBillId:     bigint('saleBillId', { mode: 'number' }).references(() => saleBills.id, { onDelete: 'restrict' }),
  paymentId:      bigint('paymentId', { mode: 'number' }).references(() => payments.id, { onDelete: 'restrict' }),
  reversalOfId:   bigint('reversalOfId', { mode: 'number' }),
  refNo:          text('refNo').notNull().default(''),
  note:           text('note').notNull().default(''),
  reason:         text('reason'),
  idempotencyKey: text('idempotencyKey').notNull().unique(),
  createdBy:      text('createdBy').references(() => user.id, { onDelete: 'set null' }),
  createdByName:  text('createdByName').notNull().default(''),
  createdAt:      timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
})

/** Which credit pays which debit. Append-only; undo = a negative row pointing at the original. */
export const partyAllocations = pgTable('party_allocations', {
  id:            bigserial('id', { mode: 'number' }).primaryKey(),
  retailerId:    text('retailerId').notNull().references(() => retailers.id, { onDelete: 'restrict' }),
  debitEntryId:  bigint('debitEntryId', { mode: 'number' }).notNull().references(() => partyLedgerEntries.id, { onDelete: 'restrict' }),
  creditEntryId: bigint('creditEntryId', { mode: 'number' }).notNull().references(() => partyLedgerEntries.id, { onDelete: 'restrict' }),
  amountPaise:   bigint('amountPaise', { mode: 'number' }).notNull(),
  reversalOfId:  bigint('reversalOfId', { mode: 'number' }),
  method:        text('method').$type<'auto' | 'manual' | 'reversal'>().notNull(),
  createdBy:     text('createdBy').references(() => user.id, { onDelete: 'set null' }),
  createdAt:     timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
})

/** Read-only from the application: written only by the party_ledger_entries trigger. */
export const partyBalances = pgTable('party_balances', {
  retailerId:   text('retailerId').primaryKey().references(() => retailers.id, { onDelete: 'restrict' }),
  balancePaise: bigint('balancePaise', { mode: 'number' }).notNull().default(0),
  updatedAt:    timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
})
