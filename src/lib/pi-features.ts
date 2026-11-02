import {
  busy,
  type ConfigSaveResult,
  type Environment,
  type Runtime,
  type StorageStatus,
} from '../../shared/types';

export function piFeatureAvailability({
  runtime,
  pending,
  environment,
  storage,
  projectEnabled,
}: {
  runtime: Runtime;
  pending: boolean;
  environment?: Environment;
  storage: StorageStatus;
  projectEnabled: boolean;
}) {
  const operationReason = pending
    ? '正在处理上一项操作，请稍候。'
    : !storage.writable
      ? '本机数据目录当前只读。请关闭窗口，按主窗口的存储提示修复后重试。'
      : '';
  const prerequisiteReason = !projectEnabled
    ? '当前项目尚未信任。请关闭此窗口，在主窗口选择“启用项目”后使用 Pi 功能。'
    : !environment?.supported && !runtime.connected
      ? '尚未检测到可用的 Pi。请到“设置 → 运行环境”检查 Pi 入口并重新检测。'
      : '';
  const engineReason = operationReason || prerequisiteReason;
  const idleReason =
    engineReason ||
    (runtime.crash && runtime.crash.cleanup !== 'confirmed'
      ? '尚未确认本会话的残留命令已结束，请先处理进程恢复提示。'
      : busy(runtime.status)
        ? '本会话正在使用当前任务和历史，请停止本会话后执行。'
        : '');
  return { operationReason, prerequisiteReason, engineReason, idleReason };
}

export function configSaveNotice(result: ConfigSaveResult) {
  return result.deferred
    ? '配置已保存并备份。相关会话空闲后加载；未连接的会话下次连接时加载。'
    : result.applied
      ? '已保存并重新连接 Pi。原配置已备份。'
      : `配置已保存，原配置已备份；尚未应用到 Pi。${result.warning ?? '请修复运行环境后重新连接。'}`;
}
