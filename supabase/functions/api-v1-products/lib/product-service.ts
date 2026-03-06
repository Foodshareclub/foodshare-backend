/**
 * Product Service
 *
 * Business logic for product/listing operations.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { logger } from "../../_shared/logger.ts";

export interface CreateProductInput {
  title: string;
  description: string;
  categoryId: number;
  quantity: number;
  unit: string;
  expiryDate?: string;
  pickupLocation: { lat: number; lng: number };
  pickupAddress: string;
  imageUrls?: string[];
  dietaryInfo?: string[];
  allergens?: string[];
}

export interface UpdateProductInput {
  title?: string;
  description?: string;
  quantity?: number;
  expiryDate?: string;
  pickupLocation?: { lat: number; lng: number };
  pickupAddress?: string;
  imageUrls?: string[];
  status?: string;
}

export class ProductService {
  constructor(private supabase: SupabaseClient, private userId: string) {}

  async createProduct(input: CreateProductInput) {
    const insertData = {
      profile_id: this.userId,
      product_name: input.title,
      product_description: input.description,
      category_id: input.categoryId,
      product_quantity: input.quantity,
      product_unit: input.unit,
      product_expiry_date: input.expiryDate || null,
      product_pickup_lat: input.pickupLocation.lat,
      product_pickup_lng: input.pickupLocation.lng,
      product_pickup_address: input.pickupAddress,
      product_images: input.imageUrls || [],
      dietary_info: input.dietaryInfo || [],
      allergens: input.allergens || [],
      product_status: "available",
    };

    const { data, error } = await this.supabase
      .from("products")
      .insert(insertData)
      .select("*")
      .single();

    if (error) throw error;

    logger.info("Product created", { productId: data.id, userId: this.userId });
    return data;
  }

  async updateProduct(productId: number, input: UpdateProductInput) {
    await this.verifyOwnership(productId);

    const updateData: Record<string, unknown> = {};

    if (input.title !== undefined) updateData.product_name = input.title;
    if (input.description !== undefined) updateData.product_description = input.description;
    if (input.quantity !== undefined) updateData.product_quantity = input.quantity;
    if (input.expiryDate !== undefined) updateData.product_expiry_date = input.expiryDate;
    if (input.pickupLocation !== undefined) {
      updateData.product_pickup_lat = input.pickupLocation.lat;
      updateData.product_pickup_lng = input.pickupLocation.lng;
    }
    if (input.pickupAddress !== undefined) updateData.product_pickup_address = input.pickupAddress;
    if (input.imageUrls !== undefined) updateData.product_images = input.imageUrls;
    if (input.status !== undefined) updateData.product_status = input.status;

    const { data, error } = await this.supabase
      .from("products")
      .update(updateData)
      .eq("id", productId)
      .select("*")
      .single();

    if (error) throw error;

    logger.info("Product updated", { productId, userId: this.userId });
    return data;
  }

  async deleteProduct(productId: number) {
    await this.verifyOwnership(productId);

    const { error } = await this.supabase
      .from("products")
      .update({
        product_status: "deleted",
        deleted_at: new Date().toISOString(),
      })
      .eq("id", productId);

    if (error) throw error;

    logger.info("Product deleted", { productId, userId: this.userId });
  }

  async getProduct(productId: number) {
    const { data, error } = await this.supabase
      .from("products")
      .select(`
        *,
        profile:profiles!products_profile_id_fkey(id, nickname, avatar_url, is_verified),
        category:categories(id, name, icon)
      `)
      .eq("id", productId)
      .single();

    if (error) throw error;
    if (!data) throw new Error("Product not found");

    return data;
  }

  async getProducts(params: {
    categoryId?: number;
    status?: string;
    lat?: number;
    lng?: number;
    radius?: number;
    limit: number;
    offset: number;
  }) {
    let query = this.supabase
      .from("products")
      .select(
        `
        *,
        profile:profiles!products_profile_id_fkey(id, nickname, avatar_url),
        category:categories(id, name, icon)
      `,
        { count: "exact" },
      );

    if (params.categoryId) {
      query = query.eq("category_id", params.categoryId);
    }

    if (params.status) {
      query = query.eq("product_status", params.status);
    } else {
      query = query.eq("product_status", "available");
    }

    // Geographic filtering
    if (params.lat && params.lng && params.radius) {
      const { data: nearbyIds } = await this.supabase.rpc("get_nearby_products", {
        p_lat: params.lat,
        p_lng: params.lng,
        p_radius_km: params.radius,
      });

      if (nearbyIds && nearbyIds.length > 0) {
        query = query.in("id", nearbyIds);
      }
    }

    const { data, error, count } = await query
      .order("product_created_at", { ascending: false })
      .range(params.offset, params.offset + params.limit - 1);

    if (error) throw error;

    return { data: data || [], count: count || 0 };
  }

  private async verifyOwnership(productId: number) {
    const { data, error } = await this.supabase
      .from("products")
      .select("profile_id")
      .eq("id", productId)
      .single();

    if (error || !data) throw new Error("Product not found");
    if (data.profile_id !== this.userId) throw new Error("Unauthorized");
  }
}
