import { Router, Request, Response, NextFunction } from "express";
import { getAllUsers, getUserById } from "../services/users";

const router = Router();

// Middleware de autenticación admin
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers["x-admin-token"];

  const adminToken = process.env.ADMIN_TOKEN;
  if (!token || !adminToken || token !== adminToken) {
    res.status(401).json({ error: "Token de admin inválido" });
    return;
  }

  next();
}

router.get("/users", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const users = await getAllUsers();
    res.json({ count: users.length, users });
  } catch (error) {
    console.error("[Admin] Error listando usuarios:", error);
    res.status(500).json({ error: "Error interno" });
  }
});

router.get("/users/:id", requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const user = await getUserById(id);

    if (!user) {
      res.status(404).json({ error: "Usuario no encontrado" });
      return;
    }

    res.json(user);
  } catch (error) {
    console.error("[Admin] Error obteniendo usuario:", error);
    res.status(500).json({ error: "Error interno" });
  }
});

export default router;
