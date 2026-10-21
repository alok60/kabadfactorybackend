import { pool } from "../config/db.js";

export async function listActiveFaqs(_req, res) {
  const [rows] = await pool.execute(
    `SELECT id, question, answer, category, display_order AS displayOrder
     FROM faqs
     WHERE is_active = 1
     ORDER BY display_order, id`
  );
  res.json({ data: rows });
}

export async function getActiveCmsPage(req, res) {
  const pageType = req.params.type === "terms" ? "terms" : "privacy";
  const [[row]] = await pool.execute(
    `SELECT id, title, content, version, updated_at AS updatedAt
     FROM cms_pages
     WHERE page_type = :pageType AND is_active = 1
     ORDER BY version DESC, id DESC
     LIMIT 1`,
    { pageType }
  );
  res.json({ data: row || null });
}
