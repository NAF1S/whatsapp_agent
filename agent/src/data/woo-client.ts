import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface WooProduct {
  id: number;
  name: string;
  slug: string;
  permalink: string;
  price: string;
  regular_price: string;
  stock_quantity: number | null;
  stock_status: 'instock' | 'outofstock' | 'onbackorder';
  short_description: string;
  description: string;
  categories: { id: number; name: string; slug: string }[];
  images: { id: number; src: string; name: string }[];
}

export interface WooOrder {
  id: number;
  order_key?: string;
  status: string;
  currency: string;
  total: string;
  meta_data?: any[];
  billing: {
    first_name: string;
    last_name: string;
    phone: string;
    address_1: string;
    city: string;
  };
  shipping: {
    first_name: string;
    last_name: string;
    address_1: string;
    city: string;
  };
  line_items: {
    id: number;
    name: string;
    product_id: number;
    quantity: number;
    total: string;
  }[];
  date_created: string;
}

export class WooCommerceClient {
  private baseUrl: string;
  private consumerKey: string;
  private consumerSecret: string;

  constructor() {
    this.baseUrl = config.woocommerce.url;
    this.consumerKey = config.woocommerce.consumerKey;
    this.consumerSecret = config.woocommerce.consumerSecret;
  }

  private getAxiosConfig(params?: any) {
    return {
      auth: {
        username: this.consumerKey,
        password: this.consumerSecret,
      },
      params,
      timeout: 15000,
    };
  }

  /**
   * Search or fetch products from WooCommerce
   *
   * By default a failure is swallowed into an empty array (callers treat that as
   * "no results"). Pass `throwOnError` for callers that must distinguish "the store said
   * there are no more products" from "the store could not be reached" — e.g. the full
   * catalog sync, which must not conclude a failed page means the catalog is empty.
   */
  async getProducts(
    params?: { search?: string; per_page?: number; page?: number; category?: string },
    opts?: { throwOnError?: boolean }
  ): Promise<WooProduct[]> {
    try {
      const response = await axios.get<WooProduct[]>(
        `${this.baseUrl}/products`,
        this.getAxiosConfig({
          per_page: params?.per_page || 10,
          page: params?.page || 1,
          search: params?.search,
          category: params?.category,
        })
      );
      return response.data;
    } catch (err: any) {
      logger.error({ err: err.response?.data || err.message }, 'WooCommerce getProducts failed');
      if (opts?.throwOnError) throw err;
      return [];
    }
  }

  /**
   * Fetch single product by ID
   */
  async getProductById(id: number): Promise<WooProduct | null> {
    try {
      const response = await axios.get<WooProduct>(
        `${this.baseUrl}/products/${id}`,
        this.getAxiosConfig()
      );
      return response.data;
    } catch (err: any) {
      logger.error({ err: err.response?.data || err.message, id }, 'WooCommerce getProductById failed');
      return null;
    }
  }

  /**
   * Search orders by phone or customer id
   */
  async getOrders(params?: { search?: string; customer?: number; per_page?: number }): Promise<WooOrder[]> {
    try {
      const response = await axios.get<WooOrder[]>(
        `${this.baseUrl}/orders`,
        this.getAxiosConfig({
          per_page: params?.per_page || 5,
          search: params?.search,
          customer: params?.customer,
        })
      );
      return response.data;
    } catch (err: any) {
      logger.error({ err: err.response?.data || err.message }, 'WooCommerce getOrders failed');
      return [];
    }
  }

  /**
   * Create an order directly in WooCommerce (optional/automated)
   */
  async createOrder(orderData: any): Promise<WooOrder | null> {
    try {
      const response = await axios.post<WooOrder>(
        `${this.baseUrl}/orders`,
        orderData,
        this.getAxiosConfig()
      );
      return response.data;
    } catch (err: any) {
      logger.error({ err: err.response?.data || err.message }, 'WooCommerce createOrder failed');
      return null;
    }
  }
}

export const wooClient = new WooCommerceClient();
