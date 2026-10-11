import { normalizeRadiusGatewayUrl } from "@earendil-works/pi-ai/providers/radius-config";

export const ENV_RADIUS_GATEWAY = "PI_RADIUS_GATEWAY";

/** Radius relays require an explicitly configured operator endpoint. */
export function getRadiusGatewayUrl(): string | undefined {
	const gateway = process.env[ENV_RADIUS_GATEWAY];
	return gateway ? normalizeRadiusGatewayUrl(gateway) : undefined;
}
