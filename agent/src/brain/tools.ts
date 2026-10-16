import { ragRetriever } from '../rag/retriever';
import { wooClient } from '../data/woo-client';
import { sessionManager } from '../session/manager';
import { escalationNotifier } from '../escalation/notifier';
import { query } from '../data/db';
import { logger } from '../utils/logger';
import { sendImage } from '../channels/dispatch';

export const TOOL_DECLARATIONS = [
  {
    name: 'search_products',
    description: 'Search Hide Haven catalog for leather products (wallets, belts, cardholders, combo sets) by query or product name. Returns prices in BDT, stock status, descriptions, and direct image links.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: {
          type: 'STRING',
          description: 'Product name, type, or search term (e.g., "leather wallet", "belt", "long wallet", "card holder")',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'send_product_images',
    description: 'Send actual product photographs directly to the customer on WhatsApp. Use this whenever the customer asks to see pictures, photos, or more details of a product (e.g. "ছবি দেখতে চাই", "Chobi kothay pathalen?", "aro picture dekhte pari", "photo dekhaw"), or when showing a product. You only need to pass product_name (e.g. "Artisan Handstitched Bifold Wallet") and the system will automatically fetch and deliver the official studio photos. NEVER send URLs or Markdown links in text.',
    parameters: {
      type: 'OBJECT',
      properties: {
        product_name: {
          type: 'STRING',
          description: 'Name of the product whose photos are being sent (e.g. "Artisan Handstitched Bifold Wallet", "Embossed Stitched Moving Belt")',
        },
        product_id: {
          type: 'INTEGER',
          description: 'Optional WooCommerce product ID if known',
        },
        image_urls: {
          type: 'ARRAY',
          items: { type: 'STRING' },
          description: 'Optional array of image URLs from search_products. If omitted, the system automatically fetches verified official images from the store catalog.',
        },
        caption: {
          type: 'STRING',
          description: 'Short caption to attach to the photos (e.g. "Artisan Handstitched Bifold Wallet - 699 BDT")',
        },
      },
      required: ['product_name'],
    },
  },
  {
    name: 'search_knowledge_base',
    description: 'Search store FAQs, return policy, delivery fees, delivery times, payment options, and warranty information.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: {
          type: 'STRING',
          description: 'Question or topic to look up (e.g., "delivery charge", "shipping time", "return policy", "inside dhaka")',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'lookup_order',
    description: 'Look up customer order status by order ID or customer phone number from WooCommerce and the store database. Returns live fulfillment and courier tracking status.',
    parameters: {
      type: 'OBJECT',
      properties: {
        order_id: {
          type: 'STRING',
          description: 'The WooCommerce order ID if provided by the customer (e.g. "1822")',
        },
        phone: {
          type: 'STRING',
          description: 'Customer phone number to search past orders (e.g. "01892740307")',
        },
      },
    },
  },
  {
    name: 'place_order',
    description: 'Place an official live Cash on Delivery order in the WooCommerce store. Requires: Product name, Product ID (or SKU), recipient customer name, phone number, delivery address, and delivery area ("Inside Dhaka" 60 BDT or "Outside Dhaka" 100 BDT). Delivery is FREE when the product total is 2000 BDT or more. Set apply_new_customer_discount=true only when the customer asked for a discount and says they are a new customer.',
    parameters: {
      type: 'OBJECT',
      properties: {
        product_name: { type: 'STRING', description: 'Name of the product ordered' },
        product_id: { type: 'INTEGER', description: 'WooCommerce product ID (from search_products)' },
        customer_name: { type: 'STRING', description: 'Full name of recipient' },
        phone: { type: 'STRING', description: 'Contact phone number' },
        address: { type: 'STRING', description: 'Detailed delivery address (house, road, area, city)' },
        area: {
          type: 'STRING',
          description: 'Delivery area: "Inside Dhaka" (60 BDT) or "Outside Dhaka" (100 BDT). Ignored (free) when the product total is 2000 BDT or more.',
        },
        item_price: { type: 'NUMBER', description: 'Unit price of the product in BDT' },
        quantity: { type: 'INTEGER', description: 'Quantity ordered (defaults to 1)' },
        apply_new_customer_discount: {
          type: 'BOOLEAN',
          description: 'Set true ONLY when the customer asked for a discount and identified as a new customer. The system verifies eligibility itself and silently skips the discount for repeat customers or orders above the coupon limit.',
        },
      },
      required: ['product_name', 'customer_name', 'phone', 'address', 'area', 'item_price'],
    },
  },
  {
    name: 'request_human_escalation',
    description: 'Escalate the conversation to the human store manager/admin. Use this when the customer explicitly asks for human support ("admin", "manush", "human", "call me"), is unsatisfied/frustrated, complains about a delayed order or defect, requests wholesale/custom pricing, or whenever an issue cannot be resolved automatically. This immediately dispatches a real-time WhatsApp alert with full chat context to the store admin.',
    parameters: {
      type: 'OBJECT',
      properties: {
        reason: {
          type: 'STRING',
          description: 'Detailed reason for handoff to a human representative (e.g. "Customer wants human support", "Customer angry about delivery delay")',
        },
        situation_summary: {
          type: 'STRING',
          description: 'Summary of the customer situation and what urgent action the admin needs to take',
        },
      },
      required: ['reason'],
    },
  },
];

interface CatalogProductRow {
  id: number;
  name: string;
  price: string | number | null;
  stock_status: string | null;
}

/** Store policy: delivery is free once the product total reaches this amount (BDT). */
const FREE_DELIVERY_THRESHOLD = 2000;

/** Store policy: the 10% new-customer coupon, and the order value it is limited to. */
const NEW_CUSTOMER_COUPON = 'comeback10';
const NEW_CUSTOMER_COUPON_MAX_SUBTOTAL = 3000;

/**
 * Has this phone number ever placed an order? Gates the new-customer discount: the coupon is
 * limited to one use per customer, so a repeat customer must not be promised it. When the
 * history cannot be read we answer "not new", because promising a discount we cannot verify
 * is worse than withholding one.
 */
async function isFirstTimeCustomer(phone: string): Promise<boolean> {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 10) return false;

  const tail = digits.slice(-10);
  try {
    const res = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM customer_orders
       WHERE billing->>'phone' LIKE $1 OR shipping->>'phone' LIKE $1`,
      [`%${tail}%`]
    );
    return parseInt(res.rows[0]?.count || '0', 10) === 0;
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Order history check failed for discount eligibility; treating as an existing customer');
    return false;
  }
}

/**
 * Resolve the product a customer wants to order to an authoritative catalog row.
 * The model's product_id / product_name are treated as HINTS ONLY: id, price and stock
 * are always read back from `products` so an order can never be created against an
 * invented id, a stale price, or a product that does not exist.
 */
async function resolveOrderProduct(
  productName: string,
  hintedId?: number
): Promise<CatalogProductRow | null> {
  const fetchById = async (id: number): Promise<CatalogProductRow | null> => {
    const res = await query<CatalogProductRow>(
      'SELECT id, name, price, stock_status FROM products WHERE id = $1',
      [id]
    );
    return res.rows.length > 0 ? res.rows[0] : null;
  };

  if (hintedId != null && Number.isFinite(hintedId)) {
    const byId = await fetchById(hintedId);
    if (byId) return byId;
  }

  if (productName) {
    const matches = await ragRetriever.searchProducts(productName, 3);
    for (const match of matches) {
      const byId = await fetchById(match.id);
      if (byId) return byId;
    }
  }

  return null;
}

export async function executeTool(
  toolName: string,
  args: Record<string, any>,
  customerPhone: string,
  targetJid?: string
): Promise<Record<string, any>> {
  logger.info({ toolName, args, customerPhone, targetJid }, 'Executing agent tool');

  switch (toolName) {
    case 'search_products': {
      const queryText = args.query || '';
      const products = await ragRetriever.searchProducts(queryText, 5);

      if (products.length === 0) {
        return {
          found: false,
          message: `No products matching "${queryText}" were found in our catalog. You can suggest asking for human help or checking another product.`,
        };
      }

      const withStock = products.map((p) => ({
        id: p.id,
        name: p.name,
        sku: p.sku,
        price: `${p.price} BDT`,
        stock_status: p.stock_status,
        available: (p.stock_status || '').toLowerCase() === 'instock',
        stock_quantity: p.stock_quantity,
        short_description: p.short_description,
        image_url: Array.isArray(p.images) && p.images.length > 0 ? p.images[0] : null,
        all_images: p.images,
      }));

      const inStock = withStock.filter((p) => p.available);

      return {
        found: true,
        count: withStock.length,
        in_stock_count: inStock.length,
        note: inStock.length === 0
          ? 'NONE of these items are in stock. Do NOT offer them or take an order. Tell the customer these are currently unavailable and use search_products to find an in-stock alternative.'
          : 'Only offer items where available=true (stock_status "instock"). Never quote or take an order for an item with available=false.',
        products: withStock,
      };
    }

    case 'send_product_images': {
      const recipient = targetJid || customerPhone;
      const productName = args.product_name || '';
      const productId = args.product_id;

      const matchedProducts = await findCatalogImages(productName, productId);

      let sendQueue: Array<{ url: string; caption: string }> = [];

      if (matchedProducts.length > 0) {
        // Collect up to 2 studio photos per matched product, max 4 total
        for (const prod of matchedProducts) {
          const prodImages = prod.urls.slice(0, 2);
          for (let i = 0; i < prodImages.length; i++) {
            const caption = i === 0 ? `📸 ${prod.productName} — ${prod.price}` : '';
            sendQueue.push({ url: prodImages[i], caption });
          }
          if (sendQueue.length >= 4) break;
        }
      } else if (args.image_urls) {
        const provided = Array.isArray(args.image_urls) ? args.image_urls : [args.image_urls];
        const validProvided = provided.filter((u: any) => typeof u === 'string' && u.startsWith('http'));
        sendQueue = validProvided.slice(0, 3).map((url: string, i: number) => ({
          url,
          caption: i === 0 ? (args.caption || productName || '') : '',
        }));
      }

      if (sendQueue.length === 0) {
        return {
          success: false,
          message: `No photos found in catalog for "${productName}". DO NOT invent or type URLs in text. Inform the customer politely that studio photos are being updated, or offer to describe the product.`,
        };
      }

      let sentCount = 0;

      for (let i = 0; i < sendQueue.length; i++) {
        const item = sendQueue[i];
        try {
          // Routed by recipient: `fb:<psid>` goes to the Messenger Graph API, a WhatsApp JID
          // to the Baileys bridge. See channels/dispatch.ts.
          const ok = await sendImage(recipient, item.url, item.caption);
          if (ok) {
            sentCount++;
          }
          if (i < sendQueue.length - 1) {
            await new Promise((r) => setTimeout(r, 600));
          }
        } catch (err: any) {
          logger.error({ err: err.message, imgUrl: item.url, recipient }, 'Failed to send product image');
        }
      }

      return {
        success: sentCount > 0,
        sent_count: sentCount,
        message: sentCount > 0
          ? `Successfully sent ${sentCount} official product photo(s) directly to the customer. In your text message, tell the customer that the photos have been sent directly above and ask if they like the product or would like to order. DO NOT send URLs or markdown image links in your text.`
          : 'Could not deliver images at this moment due to a connection issue. DO NOT send URLs or broken links in your text. Reassure the customer politely and offer to answer their questions or help them place an order.',
      };
    }

    case 'search_knowledge_base': {
      const queryText = args.query || '';
      const docs = await ragRetriever.searchKnowledgeBase(queryText, 4);

      if (docs.length === 0) {
        return {
          found: false,
          message: 'Delivery fee is 60 BDT inside Dhaka (2-3 business days) and 100 BDT outside Dhaka (3-5 business days); delivery is FREE on orders of 2000 BDT or more. Cash on Delivery nationwide. All leather products carry a 2-year warranty, plus a 30-day exchange/return for unused items in original condition.',
        };
      }

      return {
        found: true,
        answers: docs.map((d) => d.content),
      };
    }

    case 'lookup_order': {
      const orderIdRaw = String(args.order_id ?? '').replace(/[^\d]/g, '');
      const orderId = orderIdRaw ? parseInt(orderIdRaw, 10) : null;
      const phoneInput = String(args.phone || customerPhone || '');
      const rawPhone = phoneInput.replace(/[^\d]/g, '');

      // Generate phone search variants (e.g., 01892740307 and 8801892740307)
      const phoneVariants = new Set<string>();
      if (rawPhone) {
        phoneVariants.add(rawPhone);
        if (rawPhone.startsWith('880')) {
          phoneVariants.add('0' + rawPhone.substring(3));
        } else if (rawPhone.startsWith('0')) {
          phoneVariants.add('88' + rawPhone);
          phoneVariants.add(rawPhone.substring(1));
        }
      }

      // 1. If Order ID provided, query WooCommerce by ID
      if (orderId) {
        try {
          const orders = await wooClient.getOrders({ search: `${orderId}`, per_page: 1 });
          const exact = orders.find((o) => o.id === orderId) || orders[0];
          if (exact) {
            return formatOrderResult(exact);
          }
        } catch (err: any) {
          logger.error({ err: err.message, orderId }, 'WooCommerce order ID lookup failed');
        }
      }

      // 2. Query WooCommerce by phone variants
      for (const p of phoneVariants) {
        try {
          const orders = await wooClient.getOrders({ search: p, per_page: 3 });
          if (orders.length > 0) {
            return {
              found: true,
              orders: orders.map(formatOrderDetails),
            };
          }
        } catch (err: any) {
          logger.warn({ err: err.message, phone: p }, 'WooCommerce phone search failed');
        }
      }

      // 3. Fallback: Query Supabase customer_orders table
      for (const p of phoneVariants) {
        try {
          const dbOrders = await query<any>(
            `SELECT * FROM customer_orders 
             WHERE billing->>'phone' LIKE $1 OR shipping->>'phone' LIKE $1
             ORDER BY created_at DESC LIMIT 3`,
            [`%${p}%`]
          );
          if (dbOrders.rows.length > 0) {
            return {
              found: true,
              source: 'store_database',
              orders: dbOrders.rows.map((row) => ({
                order_id: row.id,
                status: row.status,
                total: `${row.total} ${row.currency}`,
                date: row.created_at,
                items: Array.isArray(row.line_items) ? row.line_items.map((i: any) => `${i.name} (x${i.quantity})`) : [],
              })),
            };
          }
        } catch (err: any) {
          logger.warn({ err: err.message }, 'Database orders lookup failed');
        }
      }

      // 4. Fallback: Check customer session metadata
      try {
        const session = await sessionManager.getOrCreateSession(customerPhone);
        if (session.metadata?.last_order) {
          const lo = session.metadata.last_order;
          return {
            found: true,
            source: 'session_cache',
            orders: [
              {
                order_id: lo.orderId || 'Recent Order (Processing)',
                status: 'Processing (Confirmed by AI agent)',
                total: `${lo.totalBill} BDT`,
                date: lo.placedAt,
                items: [`${lo.product} (x${lo.quantity || 1})`],
                recipient: lo.customerName,
                address: lo.address,
              },
            ],
          };
        }
      } catch (err: any) {
        logger.warn({ err: err.message }, 'Session order check failed');
      }

      return {
        found: false,
        message: 'No orders found matching this order ID or phone number. Ask the customer to confirm their 11-digit phone number or order number.',
      };
    }

    case 'place_order': {
      const qty = Math.max(1, parseInt(args.quantity, 10) || 1);
      const quotedPrice = parseFloat(args.item_price) || 0;
      const customerName = String(args.customer_name || '').trim();
      const customerPhoneInput = String(args.phone || '').trim();
      const address = String(args.address || '').trim();
      const areaLower = String(args.area || '').toLowerCase().trim();
      const addrLower = address.toLowerCase();

      // 0. Validate the recipient details BEFORE touching WooCommerce.
      const phoneDigits = customerPhoneInput.replace(/\D/g, '');
      if (!customerName || !address || phoneDigits.length < 10) {
        logger.warn({ customerPhone, hasName: !!customerName, hasAddress: !!address, phoneDigits: phoneDigits.length },
          'place_order rejected: incomplete recipient details');
        return {
          success: false,
          error: 'incomplete_customer_details',
          message: 'The order was NOT placed because recipient details are incomplete. Ask the customer for the missing item(s): full name, 11-digit mobile number, and full delivery address — then retry.',
        };
      }

      // Check delivery area: Inside Dhaka 60 BDT, Outside Dhaka 100 BDT.
      // An explicit area wins; the address is only consulted when the area is ambiguous.
      const outsideMarkers = ['narayanganj', 'নারায়ণগঞ্জ', 'gazipur', 'গাজীপুর', 'chittagong', 'chattogram',
        'চট্টগ্রাম', 'sylhet', 'সিলেট', 'khulna', 'খুলনা', 'rajshahi', 'রাজশাহী'];
      let isOutside: boolean | null = null;
      if (areaLower.includes('outside') || areaLower.includes('বাইরে')) {
        isOutside = true;
      } else if (areaLower.includes('inside') || areaLower.includes('ভিতরে') ||
                 areaLower.includes('dhaka') || areaLower.includes('ঢাকা')) {
        isOutside = false;
      } else if (outsideMarkers.some((m) => addrLower.includes(m))) {
        isOutside = true;
      } else if (addrLower.includes('dhaka') || addrLower.includes('ঢাকা')) {
        isOutside = false;
      }

      if (isOutside === null) {
        logger.warn({ customerPhone, area: args.area, address }, 'place_order rejected: delivery area unclear');
        return {
          success: false,
          error: 'delivery_area_unclear',
          message: 'The order was NOT placed because the delivery area is unclear. Confirm with the customer whether the address is INSIDE Dhaka (60 BDT) or OUTSIDE Dhaka (100 BDT), then retry with area set to exactly "Inside Dhaka" or "Outside Dhaka".',
        };
      }

      const isInsideDhaka = !isOutside;
      const standardDeliveryFee = isInsideDhaka ? 60 : 100;

      // 1. Resolve the product for real — the model's id/name is only a hint.
      const hintedId = args.product_id != null ? Number(args.product_id) : undefined;
      const resolved = await resolveOrderProduct(String(args.product_name || ''), hintedId);

      if (!resolved) {
        logger.warn({ customerPhone, productName: args.product_name, hintedId: args.product_id },
          'place_order rejected: product not found in catalog');
        return {
          success: false,
          error: 'product_not_found',
          message: `NO order was placed: "${args.product_name}" could not be matched to a product in our catalog. Call search_products first, then retry place_order using the exact product_id that search_products returned. Never order a product you have not verified.`,
        };
      }

      const catalogPrice = parseFloat(String(resolved.price ?? ''));
      if (!Number.isFinite(catalogPrice) || catalogPrice <= 0) {
        logger.error({ productId: resolved.id, price: resolved.price }, 'place_order rejected: catalog price missing');
        return {
          success: false,
          error: 'price_unavailable',
          message: `NO order was placed: the catalog has no valid price for "${resolved.name}". Do not guess a price — call request_human_escalation so the admin can quote and take this order.`,
        };
      }

      if ((resolved.stock_status || '').toLowerCase() === 'outofstock') {
        logger.warn({ productId: resolved.id, name: resolved.name, customerPhone }, 'place_order rejected: out of stock');
        return {
          success: false,
          error: 'out_of_stock',
          message: `NO order was placed: "${resolved.name}" is currently OUT OF STOCK. Apologise to the customer and offer an in-stock alternative from search_products. Never promise or order an out-of-stock item.`,
        };
      }

      // The catalog is authoritative for price. If the model quoted something different,
      // charge the catalog price and let it correct the customer.
      const itemPrice = catalogPrice;
      if (quotedPrice > 0 && Math.abs(quotedPrice - catalogPrice) >= 1) {
        logger.warn({ quotedPrice, catalogPrice, productId: resolved.id },
          'place_order: quoted price differed from catalog; using catalog price');
      }

      const subtotal = itemPrice * qty;

      // Store policy: free delivery once the product total reaches 2000 BDT. The threshold is
      // applied to the product value BEFORE any discount, so a discounted 2100 BDT order still
      // ships free.
      const freeDelivery = subtotal >= FREE_DELIVERY_THRESHOLD;
      const deliveryFee = freeDelivery ? 0 : standardDeliveryFee;

      // Store policy: 10% welcome discount for new customers, on request only. Eligibility is
      // verified here rather than trusted from the model, and the coupon's own maximum order
      // value is respected so WooCommerce can never reject the whole order over the coupon.
      let appliedCoupon: string | null = null;
      let discountSkippedReason: string | null = null;

      if (args.apply_new_customer_discount === true) {
        if (subtotal > NEW_CUSTOMER_COUPON_MAX_SUBTOTAL) {
          discountSkippedReason = 'order value above the coupon limit';
        } else if (!(await isFirstTimeCustomer(customerPhoneInput))) {
          discountSkippedReason = 'customer has ordered before';
        } else {
          appliedCoupon = NEW_CUSTOMER_COUPON;
        }

        if (discountSkippedReason) {
          logger.info({ phone: customerPhoneInput, subtotal, reason: discountSkippedReason },
            'New-customer discount not applied');
        }
      }

      const discountAmount = appliedCoupon ? Math.round(subtotal * 0.1 * 100) / 100 : 0;
      const total = Math.round((subtotal - discountAmount + deliveryFee) * 100) / 100;

      const priceCorrectionNote = quotedPrice > 0 && Math.abs(quotedPrice - catalogPrice) >= 1
        ? ` Note: the price you quoted (${quotedPrice} BDT) differs from the catalog price (${catalogPrice} BDT). Politely correct the price in your reply.`
        : '';

      const discountNote = appliedCoupon
        ? ` The 10% new-customer discount (${discountAmount} BDT off) has been applied with code ${appliedCoupon}.`
        : discountSkippedReason === 'customer has ordered before'
          ? ' No new-customer discount was applied because this customer has ordered before — do not promise one.'
          : discountSkippedReason === 'order value above the coupon limit'
            ? ' No new-customer discount was applied because this order is above the coupon limit — do not promise one.'
            : '';

      const freeDeliveryNote = freeDelivery
        ? ' Delivery is FREE because the order is 2000 BDT or more.'
        : '';

      // 2. Prepare official WooCommerce Order Payload
      const wooPayload = {
        payment_method: 'cod',
        payment_method_title: 'Cash on delivery',
        set_paid: false,
        status: 'processing',
        billing: {
          first_name: customerName,
          phone: customerPhoneInput,
          address_1: address,
          city: isInsideDhaka ? 'Dhaka' : 'Outside Dhaka',
        },
        shipping: {
          first_name: customerName,
          phone: customerPhoneInput,
          address_1: address,
          city: isInsideDhaka ? 'Dhaka' : 'Outside Dhaka',
        },
        line_items: [
          {
            product_id: resolved.id,
            quantity: qty,
          },
        ],
        shipping_lines: [
          {
            method_id: 'flat_rate',
            method_title: freeDelivery
              ? 'Free Delivery (order 2000 BDT or more)'
              : (isInsideDhaka ? 'Inside Dhaka Delivery' : 'Outside Dhaka Delivery'),
            total: `${deliveryFee}.00`,
          },
        ],
        // Applied by code so the discount is on the order the courier collects against.
        ...(appliedCoupon ? { coupon_lines: [{ code: appliedCoupon }] } : {}),
        // `customerPhoneInput` (what the customer typed) rather than `customerPhone` (the
        // session identity): for a Messenger customer the identity is "fb:<psid>", which has
        // no business being stamped into a WooCommerce order.
        customer_note: `Order placed via Hide Haven AI Assistant for ${customerPhoneInput}`,
      };

      // 3. Create live order in WooCommerce. A missing id means the order does NOT exist:
      //    never report success (or invent an order number) in that case.
      logger.info({ customerPhone, product: resolved.name, productId: resolved.id, qty, total },
        'Creating order in WooCommerce');
      const wooOrder = await wooClient.createOrder(wooPayload);

      if (!wooOrder || !wooOrder.id) {
        logger.error({ customerPhone, productId: resolved.id, total },
          'Order creation failed in WooCommerce — no order exists');
        return {
          success: false,
          error: 'order_creation_failed',
          message: 'The WooCommerce order could NOT be created, so the customer\'s order is NOT placed. Apologise, do NOT give the customer any order number, and call request_human_escalation so the admin can take the order manually.',
        };
      }

      const officialOrderId = wooOrder.id;

      const orderRecord = {
        orderId: officialOrderId,
        product: resolved.name,
        productId: resolved.id,
        quantity: qty,
        unitPrice: itemPrice,
        deliveryFee,
        freeDelivery,
        discountCode: appliedCoupon,
        discountAmount,
        deliveryArea: isInsideDhaka ? 'Inside Dhaka' : 'Outside Dhaka',
        totalBill: total,
        customerName,
        customerPhone: customerPhoneInput,
        address,
        placedAt: new Date().toISOString(),
        wooCommerceSuccess: true,
      };

      // 4. Persist order in Supabase customer_orders table
      if (wooOrder) {
        try {
          await query(
            `INSERT INTO customer_orders (
              id, order_key, status, currency, total, billing, shipping, line_items, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
            ON CONFLICT (id) DO UPDATE SET
              status = EXCLUDED.status,
              total = EXCLUDED.total,
              updated_at = NOW()`,
            [
              wooOrder.id,
              wooOrder.order_key || `wc_order_${wooOrder.id}`,
              wooOrder.status || 'processing',
              wooOrder.currency || 'BDT',
              total,
              JSON.stringify(wooOrder.billing || {}),
              JSON.stringify(wooOrder.shipping || {}),
              JSON.stringify(wooOrder.line_items || []),
            ]
          );
        } catch (dbErr: any) {
          logger.warn({ err: dbErr.message }, 'Failed to cache order into customer_orders table');
        }
      }

      // 5. Update session metadata & system notification.
      //    The order already exists in WooCommerce, so a local bookkeeping failure must NOT
      //    turn a successful order into a reported failure.
      try {
        await sessionManager.updateSessionMetadata(customerPhone, {
          last_order: orderRecord,
        });

        await sessionManager.addMessage(
          customerPhone,
          'system',
          `[WOOCOMMERCE ORDER #${officialOrderId} CONFIRMED]: Product: ${resolved.name} (x${qty}) | Total: ${total} BDT (Delivery: ${deliveryFee} BDT${freeDelivery ? ' — FREE' : ''}${appliedCoupon ? `, discount: ${appliedCoupon} -${discountAmount} BDT` : ''}) | Recipient: ${customerName} (${customerPhoneInput}) | Address: ${address}`
        );
      } catch (bookkeepingErr: any) {
        logger.error({ err: bookkeepingErr.message, orderId: officialOrderId },
          'Order placed but session bookkeeping failed — order is still valid');
      }

      return {
        success: true,
        order_id: officialOrderId,
        order_details: {
          order_number: `#${officialOrderId}`,
          product: resolved.name,
          quantity: qty,
          unit_price: `${itemPrice} BDT`,
          product_total: `${subtotal} BDT`,
          delivery_area: orderRecord.deliveryArea,
          delivery_fee: freeDelivery ? '0 BDT (free delivery)' : `${deliveryFee} BDT`,
          discount: appliedCoupon ? `${discountAmount} BDT off (${appliedCoupon})` : null,
          total_bill: `${total} BDT`,
          recipient: customerName,
          phone: customerPhoneInput,
          address,
        },
        message: `Order #${officialOrderId} has been created successfully in WooCommerce! Inform the customer that their order #${officialOrderId} is confirmed. Total bill is ${total} BDT (Product: ${subtotal} BDT + Delivery: ${deliveryFee} BDT, Cash on Delivery). Our fulfillment team will package and hand over to Steadfast courier soon.${freeDeliveryNote}${discountNote}${priceCorrectionNote}`,
      };
    }

    case 'request_human_escalation': {
      const reason = args.reason || 'Customer requested human assistance';
      const situationSummary = args.situation_summary || '';

      // 1. Lock customer session for human handoff in database
      await sessionManager.lockForHuman(customerPhone, reason);

      // 2. Dispatch real-time WhatsApp situation report to store admin
      const alertResult = await escalationNotifier.sendAdminEscalationAlert({
        customerPhone,
        reason,
        situationSummary,
      });

      return {
        success: true,
        escalated: true,
        admin_notified: alertResult.sent,
        message: 'The session has been locked for human support and an urgent WhatsApp situation report has been dispatched to the store admin. Inform the customer politely that the store manager/admin has been notified with all details and will take over this conversation shortly.',
      };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

function formatOrderResult(o: any) {
  return {
    found: true,
    ...formatOrderDetails(o),
  };
}

function formatOrderDetails(o: any) {
  const meta: any[] = Array.isArray(o.meta_data) ? o.meta_data : [];
  const courierName = meta.find((m) => m.key === 'eom_courier_name')?.value || null;
  const trackingId = meta.find((m) => m.key === 'eom_tracking_id')?.value || null;
  const trackingUrl = meta.find((m) => m.key === 'eom_courier_tracking_url')?.value || null;
  const courierStatus = meta.find((m) => m.key === 'eom_courier_status')?.value || null;

  return {
    order_id: o.id,
    status: o.status,
    total: `${o.total} ${o.currency || 'BDT'}`,
    date: o.date_created,
    items: Array.isArray(o.line_items) ? o.line_items.map((i: any) => `${i.name} (x${i.quantity})`) : [],
    recipient: o.billing?.first_name || '',
    phone: o.billing?.phone || '',
    courier: courierName
      ? {
          courier_name: courierName,
          tracking_id: trackingId,
          tracking_url: trackingUrl,
          courier_status: courierStatus,
        }
      : null,
  };
}

export interface CatalogImageResult {
  productName: string;
  price: string;
  urls: string[];
}

let catalogCache: Array<{ id: number; name: string; price: string; images: string[] }> = [];
let lastCatalogFetch = 0;

async function getCachedCatalog() {
  const now = Date.now();
  if (catalogCache.length === 0 || now - lastCatalogFetch > 300000) {
    try {
      const res = await query<any>('SELECT id, name, price, images FROM products ORDER BY id');
      catalogCache = res.rows.map((r) => ({
        id: r.id,
        name: r.name,
        price: `${r.price} BDT`,
        images: Array.isArray(r.images) ? r.images.filter((u: any) => typeof u === 'string' && u.startsWith('http')) : [],
      }));
      lastCatalogFetch = now;
    } catch (err: any) {
      logger.error({ err: err.message }, 'Failed to refresh catalog cache');
    }
  }
  return catalogCache;
}

export async function findCatalogImages(queryOrName: string, productId?: number): Promise<CatalogImageResult[]> {
  const catalog = await getCachedCatalog();
  if (catalog.length === 0) return [];

  // 1. Direct ID match
  if (productId) {
    const found = catalog.find((p) => p.id === productId);
    if (found && found.images.length > 0) {
      return [{ productName: found.name, price: found.price, urls: found.images }];
    }
  }

  if (!queryOrName || !queryOrName.trim()) return [];

  // 2. Split compound queries (e.g. "Wallet and Belt", "Mini Wallet & Long Wallet", "Sovereign Napa, Artisan Handstitched")
  const subQueries = queryOrName
    .split(/\s+(?:and|&|\+|বা|ও|এবং|অথবা)\s+|,|\n/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const matchedProducts: Array<{ productName: string; price: string; urls: string[] }> = [];
  const seenIds = new Set<number>();

  for (const sub of (subQueries.length > 0 ? subQueries : [queryOrName])) {
    // Clean text: strip prices, currency, punctuation
    const clean = sub.toLowerCase()
      .replace(/[\d]+(\.\d+)?\s*(টাকা|bdt|tk|৳)?/gi, '')
      .replace(/[-–—(),.+]/g, ' ')
      .trim();

    if (!clean) continue;

    // Filter query tokens
    const queryTokens = clean.split(/\s+/).filter(
      (w) => w.length > 2 && !['and', 'the', 'for', 'with', 'leather', 'লেদার', 'এর', 'ছবি', 'দাও', 'দেন', 'product', 'item'].includes(w)
    );

    let bestMatch: (typeof catalog)[0] | null = null;
    let bestScore = 0;
    const isComboQuery = clean.includes('combo') || clean.includes('কম্বো');

    for (const p of catalog) {
      if (seenIds.has(p.id) || p.images.length === 0) continue;
      const pNameLower = p.name.toLowerCase();
      const isProductCombo = pNameLower.includes('combo');

      // Exact substring match
      if (pNameLower.includes(clean) && clean.length > 3) {
        bestMatch = p;
        bestScore = 100;
        break;
      }

      // Token overlap
      let matches = 0;
      for (const t of queryTokens) {
        if (pNameLower.includes(t)) {
          matches++;
        }
      }

      if (matches > 0) {
        let score = matches / Math.max(queryTokens.length, 1);
        // Deprioritize combo products if the customer did not ask for a combo
        if (!isComboQuery && isProductCombo) {
          score *= 0.6;
        }
        if (score > bestScore) {
          bestScore = score;
          bestMatch = p;
        }
      }
    }

    if (bestMatch && (bestScore >= 0.25 || bestScore === 100)) {
      seenIds.add(bestMatch.id);
      matchedProducts.push({
        productName: bestMatch.name,
        price: bestMatch.price,
        urls: bestMatch.images,
      });
    }
  }

  // Fallback to RAG search if no products matched
  if (matchedProducts.length === 0) {
    try {
      const ragResults = await ragRetriever.searchProducts(queryOrName, 2);
      for (const r of ragResults) {
        if (!seenIds.has(r.id) && Array.isArray(r.images) && r.images.length > 0) {
          seenIds.add(r.id);
          matchedProducts.push({
            productName: r.name,
            price: `${r.price} BDT`,
            urls: r.images,
          });
        }
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, 'RAG product search fallback failed');
    }
  }

  return matchedProducts;
}
