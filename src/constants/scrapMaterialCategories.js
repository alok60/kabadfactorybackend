export const SCRAP_MATERIAL_CATEGORIES = ["Paper", "Plastic", "Metal", "E-waste", "Glass", "Rubber", "Other", "Textile"];

export function normalizeScrapMaterialCategory(value) {
  const category = String(value || "Other").trim();
  return SCRAP_MATERIAL_CATEGORIES.includes(category) ? category : null;
}
