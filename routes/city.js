import { requireAuth } from "../middleware/auth.js";
import { PLAN_PERMISSIONS } from "../config/permissions.js";

app.post("/api/city/add", requireAuth, async (req, res) => {
  const { plan } = req.user;
  const permissions = PLAN_PERMISSIONS[plan];

  if (!permissions || permissions.addNewCities <= 0) {
    return res.status(403).json({
      error: "Your plan does not allow adding new cities"
    });
  }

  // 👉 ovde ide AI + upis grada
});
