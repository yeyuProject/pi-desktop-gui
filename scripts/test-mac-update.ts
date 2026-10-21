// Reuse the production update acceptance harness in the existing native macOS CI job.
if (process.platform === 'darwin') await import('./test-update.ts');
export {};
