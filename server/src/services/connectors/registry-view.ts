/**
 * Narrow read-only slice of the connector registry that the outbound
 * publisher needs. Avoids a circular import between registry.ts and
 * outbound-publisher.ts.
 */
import type { Connector, ConnectorPlatform } from './types';

export interface ConnectorRegistryView {
  /**
   * Resolve the connector for a given binding. Falls back to the
   * deploy-wide bot when `botUserId` is null or the BYO connector
   * isn't registered (e.g. token revoked since boot).
   */
  getForBinding(
    platform: ConnectorPlatform,
    botUserId: string | null,
  ): Connector | undefined;
}
