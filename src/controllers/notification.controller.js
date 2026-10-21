import { z } from "zod";
import { pool } from "../config/db.js";

export const listNotificationsSchema = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(50).optional().default(20),
    offset: z.coerce.number().int().min(0).optional().default(0)
  })
});

export async function listNotifications(req, res) {
  const { limit, offset } = req.validated.query;
  const [rows] = await pool.execute(
    `SELECT n.id, n.title, n.body, n.type, n.created_at AS createdAt,
            CASE WHEN n.is_read = 1 OR nr.notification_id IS NOT NULL THEN TRUE ELSE FALSE END AS isRead
     FROM notifications n
     LEFT JOIN notification_reads nr
       ON nr.notification_id = n.id AND nr.user_id = :userId
     WHERE (n.user_id = :userId OR n.user_id IS NULL)
       AND nr.cleared_at IS NULL
     ORDER BY n.created_at DESC, n.id DESC
     LIMIT :limit OFFSET :offset`,
    { userId: req.user.id, limit, offset }
  );

  res.json({ data: rows, pagination: { limit, offset, hasMore: rows.length === limit } });
}

export async function unreadNotificationCount(req, res) {
  const [[row]] = await pool.execute(
    `SELECT COUNT(*) AS count
     FROM notifications n
     LEFT JOIN notification_reads nr
       ON nr.notification_id = n.id AND nr.user_id = :userId
     WHERE (n.user_id = :userId OR n.user_id IS NULL)
       AND n.is_read = 0
       AND nr.notification_id IS NULL
       AND nr.cleared_at IS NULL`,
    { userId: req.user.id }
  );

  res.json({ count: Number(row?.count || 0) });
}

export async function markNotificationRead(req, res) {
  const notificationId = Number(req.params.id);
  const [[notification]] = await pool.execute(
    "SELECT id FROM notifications WHERE id = :notificationId AND (user_id = :userId OR user_id IS NULL) LIMIT 1",
    { notificationId, userId: req.user.id }
  );

  if (!notification) {
    return res.status(404).json({ message: "Notification not found." });
  }

  await pool.execute(
    `INSERT INTO notification_reads (user_id, notification_id)
     VALUES (:userId, :notificationId)
     ON DUPLICATE KEY UPDATE read_at = CURRENT_TIMESTAMP`,
    { userId: req.user.id, notificationId }
  );

  res.json({ message: "Notification marked as read." });
}

export async function markAllNotificationsRead(req, res) {
  await pool.execute(
    `INSERT INTO notification_reads (user_id, notification_id)
     SELECT :userId, n.id
     FROM notifications n
     LEFT JOIN notification_reads nr
       ON nr.notification_id = n.id AND nr.user_id = :userId
     WHERE (n.user_id = :userId OR n.user_id IS NULL)
       AND nr.cleared_at IS NULL
     ON DUPLICATE KEY UPDATE read_at = CURRENT_TIMESTAMP`,
    { userId: req.user.id }
  );

  res.json({ message: "Notifications marked as read." });
}

export async function clearNotifications(req, res) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [[visible]] = await connection.execute(
      `SELECT COUNT(*) AS count
       FROM notifications n
       LEFT JOIN notification_reads nr
         ON nr.notification_id = n.id AND nr.user_id = :userId
       WHERE (n.user_id = :userId OR n.user_id IS NULL)
         AND (nr.notification_id IS NULL OR nr.cleared_at IS NULL)`,
      { userId: req.user.id }
    );

    await connection.execute(
      `INSERT IGNORE INTO notification_reads (user_id, notification_id, read_at, cleared_at)
       SELECT :userId, n.id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
       FROM notifications n
       LEFT JOIN notification_reads nr
         ON nr.notification_id = n.id AND nr.user_id = :userId
       WHERE (n.user_id = :userId OR n.user_id IS NULL)
         AND (nr.notification_id IS NULL OR nr.cleared_at IS NULL)`,
      { userId: req.user.id }
    );

    await connection.execute(
      `UPDATE notification_reads nr
       JOIN notifications n ON n.id = nr.notification_id
       SET nr.read_at = COALESCE(nr.read_at, CURRENT_TIMESTAMP),
           nr.cleared_at = CURRENT_TIMESTAMP
       WHERE nr.user_id = :userId
         AND (n.user_id = :userId OR n.user_id IS NULL)
         AND nr.cleared_at IS NULL`,
      { userId: req.user.id }
    );

    await connection.commit();

    res.json({
      success: true,
      message: Number(visible?.count || 0) > 0 ? "Notifications cleared successfully." : "No notifications to clear."
    });
  } catch (error) {
    await connection.rollback();
    console.error("Failed to clear notifications", { userId: req.user?.id, error });
    res.status(500).json({ success: false, message: "Could not clear notifications. Please try again." });
  } finally {
    connection.release();
  }
}
