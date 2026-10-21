import { Hono } from "hono";
import search from "./search.ts";

export const searchRouter = new Hono();
searchRouter.route("/search", search);
