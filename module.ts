import { module } from "@prisma/composer";
import app from "./service.ts";

export default module("qa-react-router", ({ provision }) => {
  provision(app);
});
