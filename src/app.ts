import { loadConfig, type AppConfig } from "./config.js";
import { BrowserSession } from "./auth/browser-session.js";
import { BrowserChicTripTransport } from "./transport/browser.js";
import { JsonStateStore } from "./state/store.js";
import { ApprovalService } from "./state/approval.js";
import { TripService } from "./service/trip-service.js";
import type { ChicTripTransport } from "./domain/types.js";

export interface AppContext {
  config: AppConfig;
  session: BrowserSession;
  transport: ChicTripTransport;
  store: JsonStateStore;
  approval: ApprovalService;
  service: TripService;
}

export function createAppContext(options: {
  config?: AppConfig;
  transport?: ChicTripTransport;
} = {}): AppContext {
  const config = options.config ?? loadConfig();
  const session = new BrowserSession(config);
  const transport =
    options.transport ?? new BrowserChicTripTransport(session, config);
  const store = new JsonStateStore(config.stateDir);
  const approval = new ApprovalService(store, config.approvalTtlMs);
  const service = new TripService(transport, store, approval, config);
  return { config, session, transport, store, approval, service };
}
