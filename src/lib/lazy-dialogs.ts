import { lazy } from 'react';
const settings = () => import('../components/SettingsModal');
const features = () => import('../PiFeatures');
const quickSwitch = () => import('../components/QuickSwitch');
const sideChat = () => import('../components/SideChatPanel');
const checkpoint = () => import('../components/CheckpointDialog');
const updates = () => import('../components/UpdateDialog');
const crash = () => import('../components/CrashCard');
const automaticUpdate = () => import('../components/AutomaticUpdate');
export const CrashCard = lazy(() => crash().then((m) => ({ default: m.CrashCard })));
export const AutomaticUpdate = lazy(() => automaticUpdate().then((m) => ({ default: m.AutomaticUpdate })));
export const SettingsModal = lazy(() => settings().then((m) => ({ default: m.SettingsModal })));
export const PiFeatures = lazy(() => features().then((m) => ({ default: m.PiFeatures })));
export const QuickSwitch = lazy(() => quickSwitch().then((m) => ({ default: m.QuickSwitch })));
export const SideChatPanel = lazy(() => sideChat().then((m) => ({ default: m.SideChatPanel })));
export const CheckpointDialog = lazy(() => checkpoint().then((m) => ({ default: m.CheckpointDialog })));
export const UpdateDialog = lazy(() => updates().then((m) => ({ default: m.UpdateDialog })));
export function preloadDialogs() {
  void Promise.allSettled([
    settings(),
    features(),
    quickSwitch(),
    sideChat(),
    checkpoint(),
    updates(),
    crash(),
    automaticUpdate(),
  ]);
}

export const AboutUpdates = lazy(() =>
  import('../components/UpdateDetails').then((module) => ({ default: module.AboutUpdates })),
);
