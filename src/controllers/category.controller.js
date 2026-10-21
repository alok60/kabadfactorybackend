import { pool } from "../config/db.js";

export async function listCategories(req, res) {
  const [rows] = await pool.execute(
    "SELECT id, name, slug, unit, price, image_url AS imageUrl, description FROM scrap_categories WHERE is_active = 1 ORDER BY display_order, name"
  );
  res.json({ data: rows.map((row) => ({ ...row, iconUrl: publicMediaUrl(req, row.imageUrl) })) });
}

function publicMediaUrl(req, value) {
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  const pathValue = String(value).startsWith("/") ? value : `/${value}`;
  return `${req.protocol}://${req.get("host")}${pathValue}`;
}
