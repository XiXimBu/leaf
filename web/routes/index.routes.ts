import homeRoutes from "./home.routes";

import { Express } from "express";

const clientRoutes = (app: Express): void => {
  app.use(`/`, homeRoutes);
  app.use(`/home`, homeRoutes);
};

export default clientRoutes;