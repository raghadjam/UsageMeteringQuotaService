import { Router } from "express";
import type { Pool } from "pg";

export function createHealthRouter(pool: Pool): Router {
  const router = Router();

  router.get("/health", async (_req, res, next) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ok" });
    } catch (error) {
      next(error);
    }
  });

  return router;
}