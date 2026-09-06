import mongoose from "mongoose";

/**
 * Cached Mongoose connection. Next.js route handlers run per-request; without
 * this cache every call would open a new socket pool. In dev, HMR wipes the
 * module scope, so we hang the promise off globalThis.
 */
type MongooseCache = {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
};

const globalForMongoose = globalThis as unknown as { _dreamsquadMongo?: MongooseCache };

const cache: MongooseCache =
  globalForMongoose._dreamsquadMongo ?? (globalForMongoose._dreamsquadMongo = { conn: null, promise: null });

export async function connectToDatabase(): Promise<typeof mongoose> {
  if (cache.conn) return cache.conn;

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");

  if (!cache.promise) {
    cache.promise = mongoose.connect(uri, {
      dbName: process.env.MONGODB_DB ?? "dreamsquad",
      bufferCommands: false,
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
  }
  try {
    cache.conn = await cache.promise;
  } catch (err) {
    // Clear rejected promise so the next call retries instead of re-throwing
    // the same stale rejection forever.
    cache.promise = null;
    throw err;
  }
  return cache.conn;
}
