import * as Cloudflare from "alchemy/Cloudflare";
import { supportStack } from "./support-stack.ts";

export default supportStack(Cloudflare.state());
