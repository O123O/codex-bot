import type { ChatDeliveryAdapter, UncertainDeliveryContext, UncertainDeliveryResolution } from "../chat/contracts.ts";
import { AppError } from "../core/errors.ts";
import type { DeliveryStore } from "../storage/delivery-store.ts";
import type { WeixinAccountStore, WeixinAuthorizationIncidentSink } from "./account-store.ts";
import { WeixinApiError, type WeixinApiClient, type WeixinSendMessageRequest } from "./api-client.ts";
import { parseWeixinDestination, type WeixinOutboundStore } from "./outbound-store.ts";

interface WeixinDeliveryApi {
  sendMessage(request: WeixinSendMessageRequest, signal?: AbortSignal): Promise<{ messageId?: string }>;
}

interface WeixinDeliveryAdapterOptions {
  api: WeixinDeliveryApi | Pick<WeixinApiClient, "sendMessage">;
  outbound: WeixinOutboundStore;
  deliveries: DeliveryStore;
  accounts: WeixinAccountStore;
  incidentSink: WeixinAuthorizationIncidentSink;
}

class WeixinTerminalDeliveryError extends Error {
  readonly deterministic = true;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WeixinTerminalDeliveryError";
  }
}

export class WeixinDeliveryAdapter implements ChatDeliveryAdapter {
  readonly id = "weixin";

  constructor(private readonly options: WeixinDeliveryAdapterOptions) {}

  async sendMessage(
    destination: Parameters<ChatDeliveryAdapter["sendMessage"]>[0],
    body: string,
    _reply?: Parameters<ChatDeliveryAdapter["sendMessage"]>[2],
    call?: { deliveryId: string },
  ): Promise<ReturnType<ChatDeliveryAdapter["sendMessage"]> extends Promise<infer T> ? T : never> {
    if (!call) throw new WeixinTerminalDeliveryError("WeChat delivery identity is required");
    const delivery = this.options.deliveries.get(call.deliveryId);
    if (!delivery || delivery.body !== body) throw new WeixinTerminalDeliveryError("WeChat delivery record is inconsistent");
    let steps;
    try {
      const target = parseWeixinDestination({ ...delivery.binding, destination });
      steps = this.options.outbound.prepareText(delivery, target);
    } catch (error) {
      this.options.deliveries.fail(delivery.id);
      throw new WeixinTerminalDeliveryError("WeChat delivery plan is invalid or inactive", { cause: error });
    }
    for (const step of steps) {
      if (step.state === "succeeded") continue;
      if (step.state !== "prepared") throw new WeixinApiError("unknown", "WeChat delivery result is unresolved", { uncertain: true });
      try { this.options.accounts.requireActive(step.generationId); }
      catch (error) {
        this.options.deliveries.fail(delivery.id);
        throw new WeixinTerminalDeliveryError("WeChat authorization is inactive", { cause: error });
      }
      this.options.outbound.begin(step.id);
      try {
        const receipt = await this.options.api.sendMessage(this.options.outbound.messageRequest(step));
        this.options.outbound.succeed(step.id, receipt);
      } catch (error) {
        if (isCredentialPinFailure(error)) {
          await this.transitionOrPreserveUncertainty(step.id, {
            generationId: step.generationId, state: "credential_changed", category: "credential_changed",
          });
          this.options.outbound.failTerminal(step.id, this.options.deliveries);
          throw new WeixinTerminalDeliveryError("WeChat credentials changed before dispatch", { cause: error });
        }
        if (error instanceof WeixinApiError && error.options.protocolCode === -14) {
          await this.transitionOrPreserveUncertainty(step.id, {
            generationId: step.generationId, state: "relogin_required", category: "authorization",
          });
          this.options.outbound.failTerminal(step.id, this.options.deliveries);
          throw new WeixinTerminalDeliveryError("WeChat authorization is no longer valid", { cause: error });
        }
        if (isProvenTerminalRejection(error)) {
          this.options.outbound.failTerminal(step.id, this.options.deliveries);
          throw new WeixinTerminalDeliveryError("WeChat rejected the delivery", { cause: error });
        }
        this.options.outbound.markUncertain(step.id);
        throw error;
      }
    }
    return { kind: "weixin", stepCount: steps.length };
  }

  async reconcileUncertain(delivery: UncertainDeliveryContext): Promise<UncertainDeliveryResolution> {
    return this.options.outbound.reconcile(delivery.id);
  }

  isSafeToRetry(): boolean { return false; }

  private async transitionOrPreserveUncertainty(
    stepId: string,
    event: Parameters<WeixinAuthorizationIncidentSink["transition"]>[0],
  ): Promise<void> {
    try { await this.options.incidentSink.transition(event); }
    catch (error) {
      this.options.outbound.markUncertain(stepId);
      throw error;
    }
  }
}

function isCredentialPinFailure(error: unknown): boolean {
  return error instanceof AppError && error.code === "CONFIGURATION_ERROR"
    && error.message.startsWith("WeChat credential");
}

function isProvenTerminalRejection(error: unknown): boolean {
  return error instanceof WeixinApiError && error.options.protocolCode !== undefined && error.uncertain === false;
}
