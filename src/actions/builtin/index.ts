import type { Catalog } from '../catalog.ts';

// Cloud — AWS
import { awsCloudwatchTail } from './aws-cloudwatch-tail.ts';
import { awsEc2Describe } from './aws-ec2-describe.ts';
import { awsRdsDescribe } from './aws-rds-describe.ts';
import { awsS3Ls } from './aws-s3-ls.ts';
// Cloud — Azure
import { azVmList } from './az-vm-list.ts';
// Docker
import { dockerComposePs } from './docker-compose-ps.ts';
import { dockerComposeUp } from './docker-compose-up.ts';
import { dockerInspect } from './docker-inspect.ts';
import { dockerLogs } from './docker-logs.ts';
import { dockerPs } from './docker-ps.ts';
// Cloud — GCP
import { gcloudComputeList } from './gcloud-compute-list.ts';
import { gcloudLoggingTail } from './gcloud-logging-tail.ts';
// VCS hosts
import { githubIssueList } from './github-issue-list.ts';
import { githubPrList } from './github-pr-list.ts';
import { githubPrView } from './github-pr-view.ts';
import { githubRunList } from './github-run-list.ts';
import { githubRunView } from './github-run-view.ts';
// Git
import { gitLog } from './git-log.ts';
import { gitStatus } from './git-status.ts';
// Kubernetes
import { kubectlContext } from './kubectl-context.ts';
import { kubectlDescribe } from './kubectl-describe.ts';
import { kubectlEvents } from './kubectl-events.ts';
import { kubectlGet } from './kubectl-get.ts';
import { kubectlLogs } from './kubectl-logs.ts';
import { kubectlTopPod } from './kubectl-top-pod.ts';
// Logs / RAG memory
import { logsTail } from './logs-tail.ts';
import { memorySearch } from './memory-search.ts';
// Network
import { networkConnections } from './network-connections.ts';
import { networkDnsLookup } from './network-dns-lookup.ts';
import { networkPing } from './network-ping.ts';
import { networkPortCheck } from './network-port-check.ts';
// Database
import { postgresIsready } from './postgres-isready.ts';
// systemd services
import { serviceJournal } from './service-journal.ts';
import { serviceStatus } from './service-status.ts';
// SSH probe
import { sshConnect } from './ssh-connect.ts';
// System
import { systemCpuInfo } from './system-cpu-info.ts';
import { systemCronList } from './system-cron-list.ts';
import { systemDiskUsage } from './system-disk-usage.ts';
import { systemDmesg } from './system-dmesg.ts';
import { systemFileStat } from './system-file-stat.ts';
import { systemIptablesList } from './system-iptables-list.ts';
import { systemListDir } from './system-list-dir.ts';
import { systemMemory } from './system-memory.ts';
import { systemOsInfo } from './system-os-info.ts';
import { systemPackageList } from './system-package-list.ts';
import { systemProcessList } from './system-process-list.ts';
import { systemSystemctlList } from './system-systemctl-list.ts';
import { systemUptime } from './system-uptime.ts';

export const BUILTIN_ACTIONS = [
  // SSH probe
  sshConnect,
  // System (basic host info)
  systemUptime,
  systemOsInfo,
  systemCpuInfo,
  systemMemory,
  systemDiskUsage,
  systemProcessList,
  systemListDir,
  systemFileStat,
  systemCronList,
  systemSystemctlList,
  systemIptablesList,
  systemDmesg,
  systemPackageList,
  // Network
  networkConnections,
  networkPortCheck,
  networkPing,
  networkDnsLookup,
  // Logs
  logsTail,
  // Services (systemd)
  serviceStatus,
  serviceJournal,
  // Docker (read)
  dockerPs,
  dockerLogs,
  dockerInspect,
  dockerComposePs,
  // Docker (mutate — M2)
  dockerComposeUp,
  // Git
  gitStatus,
  gitLog,
  // GitHub (gh CLI)
  githubPrList,
  githubPrView,
  githubRunList,
  githubRunView,
  githubIssueList,
  // Kubernetes
  kubectlGet,
  kubectlLogs,
  kubectlDescribe,
  kubectlTopPod,
  kubectlEvents,
  kubectlContext,
  // Cloud — AWS / GCP / Azure
  awsS3Ls,
  awsEc2Describe,
  awsCloudwatchTail,
  awsRdsDescribe,
  gcloudComputeList,
  gcloudLoggingTail,
  azVmList,
  // Database
  postgresIsready,
  // Project memory (RAG over runbooks / ADRs / past sessions)
  memorySearch,
] as const;

export function registerBuiltins(catalog: Catalog): void {
  for (const action of BUILTIN_ACTIONS) {
    catalog.register(action as never);
  }
}

export { awsCloudwatchTail } from './aws-cloudwatch-tail.ts';
export { awsEc2Describe } from './aws-ec2-describe.ts';
export { awsRdsDescribe } from './aws-rds-describe.ts';
export { awsS3Ls } from './aws-s3-ls.ts';
export { azVmList } from './az-vm-list.ts';
export { dockerComposePs } from './docker-compose-ps.ts';
export { dockerComposeUp } from './docker-compose-up.ts';
export { dockerInspect } from './docker-inspect.ts';
export { dockerLogs } from './docker-logs.ts';
export { dockerPs } from './docker-ps.ts';
export { gcloudComputeList } from './gcloud-compute-list.ts';
export { gcloudLoggingTail } from './gcloud-logging-tail.ts';
export { githubIssueList } from './github-issue-list.ts';
export { githubPrList } from './github-pr-list.ts';
export { githubPrView } from './github-pr-view.ts';
export { githubRunList } from './github-run-list.ts';
export { githubRunView } from './github-run-view.ts';
export { gitLog } from './git-log.ts';
export { gitStatus } from './git-status.ts';
export { kubectlContext } from './kubectl-context.ts';
export { kubectlDescribe } from './kubectl-describe.ts';
export { kubectlEvents } from './kubectl-events.ts';
export { kubectlGet } from './kubectl-get.ts';
export { kubectlLogs } from './kubectl-logs.ts';
export { kubectlTopPod } from './kubectl-top-pod.ts';
export { logsTail } from './logs-tail.ts';
export { memorySearch } from './memory-search.ts';
export { networkConnections } from './network-connections.ts';
export { networkDnsLookup } from './network-dns-lookup.ts';
export { networkPing } from './network-ping.ts';
export { networkPortCheck } from './network-port-check.ts';
export { postgresIsready } from './postgres-isready.ts';
export { serviceJournal } from './service-journal.ts';
export { serviceStatus } from './service-status.ts';
export { sshConnect } from './ssh-connect.ts';
export { systemCpuInfo } from './system-cpu-info.ts';
export { systemCronList } from './system-cron-list.ts';
export { systemDiskUsage } from './system-disk-usage.ts';
export { systemDmesg } from './system-dmesg.ts';
export { systemFileStat } from './system-file-stat.ts';
export { systemIptablesList } from './system-iptables-list.ts';
export { systemListDir } from './system-list-dir.ts';
export { systemMemory } from './system-memory.ts';
export { systemOsInfo } from './system-os-info.ts';
export { systemPackageList } from './system-package-list.ts';
export { systemProcessList } from './system-process-list.ts';
export { systemSystemctlList } from './system-systemctl-list.ts';
export { systemUptime } from './system-uptime.ts';
