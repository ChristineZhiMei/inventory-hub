import type { InventoryConfigInput } from "./config.js";
import { loadConfig } from "./config.js";
import { InventoryDatabase } from "./db/database.js";
import { AuthService } from "./services/auth.js";

export const initializeAdmin = (username: string, password: string, configInput: InventoryConfigInput = {}) => {
  const config = loadConfig(configInput);
  const database = new InventoryDatabase(config);
  try { return new AuthService(database, config).setup(username, password); }
  finally { database.close(); }
};
