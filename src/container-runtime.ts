/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const envConfig = readEnvFile(['CREDENTIAL_PROXY_HOST']);

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'container';

/**
 * Long-lived keepalive container that pins the Apple Container bridge interface up.
 * Apple Container only attaches `bridge100` (with the host gateway IP, e.g. 192.168.64.1)
 * to the macOS host while at least one container is running. When the last container
 * exits, the interface disappears and any process bound to that IP starts failing.
 * The credential proxy must bind to that IP and outlive any single agent container,
 * so we keep this idle alpine container running. Excluded from `cleanupOrphans`.
 */
export const NETWORK_KEEPALIVE_NAME = 'nanoclaw-network-keepalive';
const NETWORK_KEEPALIVE_IMAGE = 'alpine:latest';

/**
 * IP address containers use to reach the host machine.
 * Apple Container VMs use a bridge network (192.168.64.x); the host is at the gateway.
 * Detected from the bridge0 interface, falling back to 192.168.64.1.
 */
export const CONTAINER_HOST_GATEWAY = detectHostGateway();

function detectHostGateway(): string {
  // Apple Container on macOS: containers reach the host via the bridge network gateway
  const ifaces = os.networkInterfaces();
  const bridge = ifaces['bridge100'] || ifaces['bridge0'];
  if (bridge) {
    const ipv4 = bridge.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  // Fallback: Apple Container's default gateway
  return '192.168.64.1';
}

/**
 * Address the credential proxy binds to.
 * Must be set via CREDENTIAL_PROXY_HOST in .env — there is no safe default
 * for Apple Container because bridge100 only exists while containers run,
 * but the proxy must start before any container.
 * The /convert-to-apple-container skill sets this during setup.
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || envConfig.CREDENTIAL_PROXY_HOST;
if (!PROXY_BIND_HOST) {
  throw new Error(
    'CREDENTIAL_PROXY_HOST is not set in .env. Run /convert-to-apple-container to configure.',
  );
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return [
    '--mount',
    `type=bind,source=${hostPath},target=${containerPath},readonly`,
  ];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop ${name}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} system status`, { stdio: 'pipe' });
    logger.debug('Container runtime already running');
  } catch {
    logger.info('Starting container runtime...');
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} system start`, {
        stdio: 'pipe',
        timeout: 30000,
      });
      logger.info('Container runtime started');
    } catch (err) {
      logger.error({ err }, 'Failed to start container runtime');
      console.error(
        '\n╔════════════════════════════════════════════════════════════════╗',
      );
      console.error(
        '║  FATAL: Container runtime failed to start                      ║',
      );
      console.error(
        '║                                                                ║',
      );
      console.error(
        '║  Agents cannot run without a container runtime. To fix:        ║',
      );
      console.error(
        '║  1. Ensure Apple Container is installed                        ║',
      );
      console.error(
        '║  2. Run: container system start                                ║',
      );
      console.error(
        '║  3. Restart NanoClaw                                           ║',
      );
      console.error(
        '╚════════════════════════════════════════════════════════════════╝\n',
      );
      throw new Error('Container runtime is required but failed to start');
    }
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(`${CONTAINER_RUNTIME_BIN} ls --format json`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const containers: { status: string; configuration: { id: string } }[] =
      JSON.parse(output || '[]');
    const orphans = containers
      .filter(
        (c) =>
          c.status === 'running' &&
          c.configuration.id.startsWith('nanoclaw-') &&
          c.configuration.id !== NETWORK_KEEPALIVE_NAME,
      )
      .map((c) => c.configuration.id);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}

/**
 * Ensure the network keepalive container is running so `bridge100` (and the
 * host gateway IP the credential proxy binds to) stays attached to the host.
 * Idempotent: starts a stopped one, leaves a running one alone, creates a new
 * one if neither exists.
 */
export function ensureNetworkKeepalive(): void {
  try {
    const output = execSync(`${CONTAINER_RUNTIME_BIN} ls -a --format json`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const containers: { status: string; configuration: { id: string } }[] =
      JSON.parse(output || '[]');
    const existing = containers.find(
      (c) => c.configuration.id === NETWORK_KEEPALIVE_NAME,
    );
    if (existing?.status === 'running') {
      logger.debug('Network keepalive already running');
      return;
    }
    if (existing) {
      logger.info(
        { status: existing.status },
        'Starting existing network keepalive container',
      );
      execSync(`${CONTAINER_RUNTIME_BIN} start ${NETWORK_KEEPALIVE_NAME}`, {
        stdio: 'pipe',
        timeout: 30000,
      });
      return;
    }
    logger.info('Creating network keepalive container');
    execSync(
      `${CONTAINER_RUNTIME_BIN} run -d --name ${NETWORK_KEEPALIVE_NAME} ${NETWORK_KEEPALIVE_IMAGE} sleep infinity`,
      { stdio: 'pipe', timeout: 60000 },
    );
  } catch (err) {
    logger.error({ err }, 'Failed to ensure network keepalive container');
    throw new Error(
      'Network keepalive container is required to keep the host bridge interface up',
    );
  }
}

/**
 * Block until `addr` appears on a host interface, polling network interface
 * state. Apple Container attaches `bridge100` asynchronously after a container
 * is started, so callers that need to bind to the host gateway IP must wait.
 */
export function waitForHostAddress(
  addr: string,
  timeoutMs = 30000,
  pollMs = 250,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const ifaces = os.networkInterfaces();
      for (const list of Object.values(ifaces)) {
        if (list?.some((a) => a.address === addr)) return resolve();
      }
      if (Date.now() >= deadline) {
        return reject(
          new Error(
            `Host address ${addr} did not appear within ${timeoutMs}ms`,
          ),
        );
      }
      setTimeout(check, pollMs);
    };
    check();
  });
}
