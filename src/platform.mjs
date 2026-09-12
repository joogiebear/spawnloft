/** Features that still depend on Windows tools in the first Mac preview. */
export function platformCapabilities(platform = process.platform) {
  return {
    scheduler: platform === 'win32' || platform === 'darwin',
    performance: platform === 'win32' || platform === 'darwin',
    managedDatabases: platform === 'win32' || platform === 'darwin',
  }
}

export const PREVIEW_LIMITS = Object.freeze({
  scheduler: 'Scheduled tasks and automatic backups are not available in this preview on this platform. You can still start, stop, and back up servers manually.',
  performance: 'CPU and memory charts are not available in this preview on this platform. Server controls and the live console still work.',
  managedDatabases: 'Automatic database installation is not available in this preview on this platform. Connect to an existing MySQL or Redis database instead.',
})
