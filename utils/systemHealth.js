const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");
const axios = require("axios");
const AWS = require("aws-sdk");
const pool = require("../config/db");

const execFileAsync = promisify(execFile);
const EC2_METADATA_BASE = "http://169.254.169.254/latest";

const bytesFormatter = new Intl.NumberFormat("en-IN", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
});

const numberFormatter = new Intl.NumberFormat("en-IN");

const STATUS_WEIGHT = {
  healthy: 0,
  info: 0,
  warning: 1,
  critical: 2,
};

const resolveConfiguredStorageBytes = () => {
  const candidates = [
    process.env.DB_STORAGE_LIMIT_GB,
    process.env.DB_ALLOCATED_STORAGE_GB,
    process.env.RDS_ALLOCATED_STORAGE_GB,
  ];

  for (const candidate of candidates) {
    const numeric = toNumber(candidate);
    if (numeric && numeric > 0) {
      return numeric * 1024 * 1024 * 1024;
    }
  }

  return null;
};

const inferAwsRegion = () => {
  const region = String(process.env.AWS_REGION || "").trim();
  return region || null;
};

const loadRdsStorageSnapshot = async () => {
  const dbHost = String(process.env.DB_HOST || "").trim().toLowerCase();
  const region = inferAwsRegion();
  const explicitInstanceId = String(
    process.env.RDS_DB_INSTANCE_IDENTIFIER || ""
  ).trim();
  const metricsEnabled =
    String(process.env.ENABLE_AWS_RDS_STORAGE_METRICS || "true").toLowerCase() !==
    "false";

  if (!metricsEnabled) {
    return {
      source: "aws-rds",
      unavailable: true,
      reason: "RDS storage telemetry disabled by ENABLE_AWS_RDS_STORAGE_METRICS=false.",
    };
  }

  if (!dbHost || !dbHost.includes("rds.amazonaws.com")) {
    return null;
  }

  if (!region) {
    return {
      source: "aws-rds",
      unavailable: true,
      reason: "AWS_REGION is missing in environment.",
    };
  }

  try {
    const accessKeyId = String(
      process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY || ""
    ).trim();
    const secretAccessKey = String(
      process.env.AWS_SECRET_ACCESS_KEY || ""
    ).trim();
    const sessionToken = String(process.env.AWS_SESSION_TOKEN || "").trim();
    const awsOptions = {
      region,
      ...(accessKeyId && secretAccessKey
        ? {
            accessKeyId,
            secretAccessKey,
            ...(sessionToken ? { sessionToken } : {}),
          }
        : {}),
    };

    const rds = new AWS.RDS(awsOptions);
    const cloudWatch = new AWS.CloudWatch(awsOptions);
    let matchedInstance = null;

    if (explicitInstanceId) {
      const response = await rds
        .describeDBInstances({ DBInstanceIdentifier: explicitInstanceId })
        .promise();
      matchedInstance = response.DBInstances?.[0] || null;
    } else {
      let marker;
      do {
        const response = await rds.describeDBInstances({ Marker: marker }).promise();
        matchedInstance = (response.DBInstances || []).find((instance) => {
          const endpoint = String(instance?.Endpoint?.Address || "").toLowerCase();
          return endpoint === dbHost || endpoint.includes(dbHost) || dbHost.includes(endpoint);
        });
        marker = response.Marker;
      } while (!matchedInstance && marker);
    }

    if (!matchedInstance) {
      return {
        source: "aws-rds",
        unavailable: true,
        reason: explicitInstanceId
          ? `RDS instance ${explicitInstanceId} not found or not accessible.`
          : "Matching RDS instance not found for DB_HOST.",
      };
    }

    const dbInstanceIdentifier = matchedInstance.DBInstanceIdentifier;
    const allocatedStorageBytes =
      (toNumber(matchedInstance.AllocatedStorage) || 0) * 1024 * 1024 * 1024;

    let freeStorageBytes = null;
    try {
      const metricResponse = await cloudWatch
        .getMetricStatistics({
          Namespace: "AWS/RDS",
          MetricName: "FreeStorageSpace",
          Dimensions: [
            {
              Name: "DBInstanceIdentifier",
              Value: dbInstanceIdentifier,
            },
          ],
          StartTime: new Date(Date.now() - 15 * 60 * 1000),
          EndTime: new Date(),
          Period: 300,
          Statistics: ["Average"],
        })
        .promise();

      const datapoints = metricResponse.Datapoints || [];
      const latest = datapoints.sort(
        (left, right) => new Date(right.Timestamp) - new Date(left.Timestamp)
      )[0];
      freeStorageBytes = toNumber(latest?.Average);
    } catch (error) {
      freeStorageBytes = null;
    }

    return {
      source: "aws-rds",
      region,
      dbInstanceIdentifier,
      engine: matchedInstance.Engine || null,
      dbInstanceClass: matchedInstance.DBInstanceClass || null,
      multiAz: Boolean(matchedInstance.MultiAZ),
      allocatedStorageBytes,
      freeStorageBytes,
      usedStorageBytes:
        freeStorageBytes !== null && allocatedStorageBytes
          ? Math.max(allocatedStorageBytes - freeStorageBytes, 0)
          : null,
    };
  } catch (error) {
    return {
      source: "aws-rds",
      unavailable: true,
      reason: error.message,
    };
  }
};

const getEc2EnvProfile = () => {
  const instanceId = String(process.env.EC2_INSTANCE_ID || "").trim();
  if (!instanceId) return null;

  return {
    instanceId,
    instanceName: String(process.env.EC2_INSTANCE_NAME || "").trim() || null,
    instanceType: String(process.env.EC2_INSTANCE_TYPE || "").trim() || null,
    availabilityZone:
      String(process.env.EC2_AVAILABILITY_ZONE || "").trim() || null,
    region: inferAwsRegion(),
    publicIp: String(process.env.EC2_PUBLIC_IP || "").trim() || null,
    privateIp: String(process.env.EC2_PRIVATE_IP || "").trim() || null,
    publicHost: String(process.env.EC2_PUBLIC_HOST || "").trim() || null,
    privateHost: String(process.env.EC2_PRIVATE_HOST || "").trim() || null,
    vpcId: String(process.env.EC2_VPC_ID || "").trim() || null,
    subnetId: String(process.env.EC2_SUBNET_ID || "").trim() || null,
    instanceArn: String(process.env.EC2_INSTANCE_ARN || "").trim() || null,
  };
};

const createAwsServiceOptions = (region) => {
  const accessKeyId = String(
    process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY || ""
  ).trim();
  const secretAccessKey = String(
    process.env.AWS_SECRET_ACCESS_KEY || ""
  ).trim();
  const sessionToken = String(process.env.AWS_SESSION_TOKEN || "").trim();
  const awsOptions = {
    region,
    ...(accessKeyId && secretAccessKey
      ? {
          accessKeyId,
          secretAccessKey,
          ...(sessionToken ? { sessionToken } : {}),
        }
      : {}),
  };

  return awsOptions;
};

const fetchLatestCloudWatchAverage = async (
  cloudWatch,
  metricName,
  instanceId,
  statistics = ["Average"],
  period = 300
) => {
  const response = await cloudWatch
    .getMetricStatistics({
      Namespace: "AWS/EC2",
      MetricName: metricName,
      Dimensions: [
        {
          Name: "InstanceId",
          Value: instanceId,
        },
      ],
      StartTime: new Date(Date.now() - 30 * 60 * 1000),
      EndTime: new Date(),
      Period: period,
      Statistics: statistics,
    })
    .promise();

  const datapoints = response.Datapoints || [];
  const latest = datapoints.sort(
    (left, right) => new Date(right.Timestamp) - new Date(left.Timestamp)
  )[0];
  return latest || null;
};

const loadRemoteEc2Snapshot = async () => {
  const profile = getEc2EnvProfile();
  if (!profile) return null;

  const region = profile.region;
  if (!region) {
    return {
      ...profile,
      remoteConfigured: true,
      metricsUnavailable: true,
      metricsReason: "AWS_REGION is missing in environment.",
    };
  }

  try {
    const awsOptions = createAwsServiceOptions(region);
    const cloudWatch = new AWS.CloudWatch(awsOptions);
    const ec2 = new AWS.EC2(awsOptions);

    const [
      cpuPoint,
      networkInPoint,
      networkOutPoint,
      statusInstancePoint,
      statusSystemPoint,
      instanceStatusResponse,
    ] = await Promise.all([
      fetchLatestCloudWatchAverage(
        cloudWatch,
        "CPUUtilization",
        profile.instanceId
      ).catch(() => null),
      fetchLatestCloudWatchAverage(
        cloudWatch,
        "NetworkIn",
        profile.instanceId
      ).catch(() => null),
      fetchLatestCloudWatchAverage(
        cloudWatch,
        "NetworkOut",
        profile.instanceId
      ).catch(() => null),
      fetchLatestCloudWatchAverage(
        cloudWatch,
        "StatusCheckFailed_Instance",
        profile.instanceId,
        ["Maximum"]
      ).catch(() => null),
      fetchLatestCloudWatchAverage(
        cloudWatch,
        "StatusCheckFailed_System",
        profile.instanceId,
        ["Maximum"]
      ).catch(() => null),
      ec2
        .describeInstanceStatus({
          InstanceIds: [profile.instanceId],
          IncludeAllInstances: true,
        })
        .promise()
        .catch(() => null),
    ]);

    const currentStatus = instanceStatusResponse?.InstanceStatuses?.[0] || null;
    const instanceState = currentStatus?.InstanceState?.Name || "unknown";
    const instanceCheckStatus =
      currentStatus?.InstanceStatus?.Status || "unknown";
    const systemCheckStatus = currentStatus?.SystemStatus?.Status || "unknown";

    return {
      ...profile,
      remoteConfigured: true,
      metricsUnavailable: false,
      instanceState,
      instanceCheckStatus,
      systemCheckStatus,
      cpuUtilization: toNumber(cpuPoint?.Average),
      networkInBytes: toNumber(networkInPoint?.Average),
      networkOutBytes: toNumber(networkOutPoint?.Average),
      statusCheckFailedInstance:
        toNumber(statusInstancePoint?.Maximum) || 0,
      statusCheckFailedSystem: toNumber(statusSystemPoint?.Maximum) || 0,
      cpuUtilizationLabel: formatPercent(cpuPoint?.Average),
      networkInLabel: formatBytes(networkInPoint?.Average),
      networkOutLabel: formatBytes(networkOutPoint?.Average),
      checksHealthy:
        instanceCheckStatus === "ok" &&
        systemCheckStatus === "ok" &&
        (toNumber(statusInstancePoint?.Maximum) || 0) === 0 &&
        (toNumber(statusSystemPoint?.Maximum) || 0) === 0,
    };
  } catch (error) {
    return {
      ...profile,
      remoteConfigured: true,
      metricsUnavailable: true,
      metricsReason: error.message,
    };
  }
};

const determineOverallStatus = (alerts = []) => {
  let highest = "healthy";
  for (const alert of alerts) {
    const severity = alert?.severity || "info";
    if ((STATUS_WEIGHT[severity] || 0) > (STATUS_WEIGHT[highest] || 0)) {
      highest = severity;
    }
  }
  return highest;
};

const formatBytes = (value) => {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "N/A";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  const normalized = bytes / 1024 ** unitIndex;
  return `${bytesFormatter.format(normalized)} ${units[unitIndex]}`;
};

const toNumber = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const safePercent = (used, total) => {
  const safeUsed = toNumber(used);
  const safeTotal = toNumber(total);
  if (safeUsed === null || safeTotal === null || safeTotal <= 0) return null;
  return Number(((safeUsed / safeTotal) * 100).toFixed(1));
};

const parsePgSettingBytes = (setting, unit) => {
  const numeric = toNumber(setting);
  if (numeric === null) return null;
  const normalizedUnit = String(unit || "").toLowerCase();
  const multiplier =
    normalizedUnit === "8kb"
      ? 8192
      : normalizedUnit === "kb"
        ? 1024
        : normalizedUnit === "mb"
          ? 1024 * 1024
          : normalizedUnit === "gb"
            ? 1024 * 1024 * 1024
            : 1;
  return numeric * multiplier;
};

const parseDfOutput = (stdout) => {
  const lines = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;
  const lastLine = lines[lines.length - 1];
  const parts = lastLine.split(/\s+/);
  if (parts.length < 6) return null;
  const totalBytes = toNumber(parts[1]) * 1024;
  const usedBytes = toNumber(parts[2]) * 1024;
  const availableBytes = toNumber(parts[3]) * 1024;
  const usedPercent = toNumber(String(parts[4]).replace("%", ""));
  const mount = parts.slice(5).join(" ");
  return {
    mount,
    totalBytes,
    usedBytes,
    availableBytes,
    usedPercent,
  };
};

const getDiskSnapshot = async () => {
  const platform = os.platform();
  if (platform === "linux" || platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("df", ["-kP", "/"]);
      return parseDfOutput(stdout);
    } catch (error) {
      return {
        error: error.message,
      };
    }
  }

  return {
    mount: process.cwd().slice(0, 2) || "system",
    totalBytes: null,
    usedBytes: null,
    availableBytes: null,
    usedPercent: null,
    note: "Detailed disk usage is only available on the Linux host.",
  };
};

const fetchEc2Metadata = async () => {
  try {
    const tokenResponse = await axios.put(
      `${EC2_METADATA_BASE}/api/token`,
      null,
      {
        headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
        timeout: 1500,
      }
    );
    const headers = {
      "X-aws-ec2-metadata-token": tokenResponse.data,
    };

    const [identityResponse, instanceIdResponse, instanceTypeResponse, amiIdResponse] =
      await Promise.all([
        axios.get(`${EC2_METADATA_BASE}/dynamic/instance-identity/document`, {
          headers,
          timeout: 1500,
        }),
        axios.get(`${EC2_METADATA_BASE}/meta-data/instance-id`, {
          headers,
          timeout: 1500,
        }),
        axios.get(`${EC2_METADATA_BASE}/meta-data/instance-type`, {
          headers,
          timeout: 1500,
        }),
        axios.get(`${EC2_METADATA_BASE}/meta-data/ami-id`, {
          headers,
          timeout: 1500,
        }),
      ]);

    const identity = identityResponse.data || {};
    return {
      instanceId: instanceIdResponse.data || null,
      instanceType: instanceTypeResponse.data || null,
      amiId: amiIdResponse.data || null,
      availabilityZone: identity.availabilityZone || null,
      region: identity.region || null,
      privateIp: identity.privateIp || null,
      accountId: identity.accountId || null,
    };
  } catch (error) {
    return {
      unavailable: true,
      reason: error.message,
    };
  }
};

const safeQuery = async (client, sql, params = []) => {
  try {
    const result = await client.query(sql, params);
    return { rows: result.rows, rowCount: result.rowCount };
  } catch (error) {
    return { rows: [], rowCount: 0, error: error.message };
  }
};

const buildAlert = ({
  severity,
  source,
  title,
  message,
  metric = null,
  current = null,
  threshold = null,
}) => ({
  severity,
  source,
  title,
  message,
  metric,
  current,
  threshold,
});

const buildDatabaseSnapshot = async (client) => {
  const [
    dbSizeResult,
    dbCompositionResult,
    connectionsResult,
    tablesResult,
    indexesResult,
    attendanceGrowthResult,
    walSettingsResult,
    walDirectoryResult,
    walStatsResult,
    replicationSlotsResult,
    replicationStatusResult,
    vacuumCandidatesResult,
  ] = await Promise.all([
    safeQuery(
      client,
      `SELECT
         current_database() AS database_name,
         pg_database_size(current_database()) AS total_bytes,
         current_setting('server_version') AS postgres_version`
    ),
    safeQuery(
      client,
      `SELECT
         COALESCE(SUM(pg_relation_size(relid)), 0) AS table_bytes,
         COALESCE(SUM(pg_indexes_size(relid)), 0) AS index_bytes,
         COALESCE(SUM(pg_total_relation_size(relid)), 0) AS total_relation_bytes
       FROM pg_stat_user_tables`
    ),
    safeQuery(
      client,
      `SELECT
         COUNT(*) FILTER (WHERE datname = current_database()) AS total_connections,
         COUNT(*) FILTER (WHERE datname = current_database() AND state = 'active') AS active_connections,
         COUNT(*) FILTER (WHERE datname = current_database() AND wait_event IS NOT NULL) AS waiting_connections,
         current_setting('max_connections') AS max_connections
       FROM pg_stat_activity`
    ),
    safeQuery(
      client,
      `SELECT
         relname AS table_name,
         pg_total_relation_size(relid) AS total_bytes,
         pg_relation_size(relid) AS table_bytes,
         pg_indexes_size(relid) AS index_bytes,
         n_live_tup AS live_rows,
         n_dead_tup AS dead_rows,
         COALESCE(last_autovacuum, last_vacuum) AS last_maintenance_at
       FROM pg_stat_user_tables
       ORDER BY total_bytes DESC
       LIMIT 8`
    ),
    safeQuery(
      client,
      `SELECT
         indexrelname AS index_name,
         relname AS table_name,
         pg_relation_size(indexrelid) AS index_bytes
       FROM pg_stat_user_indexes
       ORDER BY index_bytes DESC
       LIMIT 8`
    ),
    safeQuery(
      client,
      `SELECT
         TO_CHAR(date, 'YYYY-MM') AS month,
         COUNT(*)::bigint AS records
       FROM attendance
       GROUP BY 1
       ORDER BY 1 DESC
       LIMIT 12`
    ),
    safeQuery(
      client,
      `SELECT name, setting, unit
       FROM pg_settings
       WHERE name IN (
         'max_wal_size',
         'min_wal_size',
         'wal_keep_size',
         'checkpoint_timeout',
         'archive_mode',
         'max_replication_slots'
       )
       ORDER BY name`
    ),
    safeQuery(
      client,
      `SELECT COALESCE(SUM(size), 0) AS wal_directory_bytes
       FROM pg_ls_waldir()`
    ),
    safeQuery(
      client,
      `SELECT wal_records, wal_fpi, wal_bytes, stats_reset
       FROM pg_stat_wal`
    ),
    safeQuery(
      client,
      `SELECT
         slot_name,
         slot_type,
         active,
         restart_lsn,
         confirmed_flush_lsn,
         pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS retained_bytes
       FROM pg_replication_slots
       ORDER BY retained_bytes DESC NULLS LAST`
    ),
    safeQuery(
      client,
      `SELECT
         application_name,
         client_addr::text AS client_addr,
         state,
         sync_state,
         pg_wal_lsn_diff(pg_current_wal_lsn(), COALESCE(replay_lsn, sent_lsn)) AS lag_bytes
       FROM pg_stat_replication`
    ),
    safeQuery(
      client,
      `SELECT
         relname AS table_name,
         n_live_tup AS live_rows,
         n_dead_tup AS dead_rows,
         ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
         last_autovacuum
       FROM pg_stat_user_tables
       WHERE n_dead_tup > 1000
       ORDER BY n_dead_tup DESC
       LIMIT 8`
    ),
  ]);

  const dbRow = dbSizeResult.rows[0] || {};
  const compositionRow = dbCompositionResult.rows[0] || {};
  const connectionRow = connectionsResult.rows[0] || {};
  const totalConnections = toNumber(connectionRow.total_connections) || 0;
  const activeConnections = toNumber(connectionRow.active_connections) || 0;
  const waitingConnections = toNumber(connectionRow.waiting_connections) || 0;
  const maxConnections = toNumber(connectionRow.max_connections) || 0;

  const settingsMap = walSettingsResult.rows.reduce((acc, row) => {
    acc[row.name] = row;
    return acc;
  }, {});

  const walDirectoryBytes = toNumber(walDirectoryResult.rows[0]?.wal_directory_bytes);
  const maxWalBytes = parsePgSettingBytes(
    settingsMap.max_wal_size?.setting,
    settingsMap.max_wal_size?.unit
  );
  const relationTableBytes = toNumber(compositionRow.table_bytes) || 0;
  const relationIndexBytes = toNumber(compositionRow.index_bytes) || 0;
  const relationTotalBytes = toNumber(compositionRow.total_relation_bytes) || 0;
  const configuredStorageBytes = resolveConfiguredStorageBytes();
  const estimatedFootprintBytes =
    (toNumber(dbRow.total_bytes) || relationTotalBytes || 0) + (walDirectoryBytes || 0);
  const estimatedFreeStorageBytes =
    configuredStorageBytes && estimatedFootprintBytes <= configuredStorageBytes
      ? configuredStorageBytes - estimatedFootprintBytes
      : null;

  return {
    connectivity: {
      ok: !dbSizeResult.error,
      error: dbSizeResult.error || null,
    },
    summary: {
      databaseName: dbRow.database_name || null,
      postgresVersion: dbRow.postgres_version || null,
      totalBytes: toNumber(dbRow.total_bytes),
      totalSizeLabel: formatBytes(dbRow.total_bytes),
      relationTableBytes,
      relationIndexBytes,
      relationTotalBytes,
      relationTableSizeLabel: formatBytes(relationTableBytes),
      relationIndexSizeLabel: formatBytes(relationIndexBytes),
      relationTotalSizeLabel: formatBytes(relationTotalBytes),
      estimatedFootprintBytes,
      estimatedFootprintSizeLabel: formatBytes(estimatedFootprintBytes),
      configuredStorageBytes,
      configuredStorageSizeLabel: formatBytes(configuredStorageBytes),
      estimatedFreeStorageBytes,
      estimatedFreeStorageSizeLabel: formatBytes(estimatedFreeStorageBytes),
      configuredUsagePercent: safePercent(
        estimatedFootprintBytes,
        configuredStorageBytes
      ),
      connectionUsagePercent: safePercent(totalConnections, maxConnections),
      totalConnections,
      activeConnections,
      waitingConnections,
      maxConnections,
    },
    tables: tablesResult.rows.map((row) => ({
      tableName: row.table_name,
      totalBytes: toNumber(row.total_bytes),
      totalSizeLabel: formatBytes(row.total_bytes),
      tableBytes: toNumber(row.table_bytes),
      indexBytes: toNumber(row.index_bytes),
      liveRows: toNumber(row.live_rows) || 0,
      deadRows: toNumber(row.dead_rows) || 0,
      lastMaintenanceAt: row.last_maintenance_at || null,
    })),
    indexes: indexesResult.rows.map((row) => ({
      indexName: row.index_name,
      tableName: row.table_name,
      indexBytes: toNumber(row.index_bytes),
      indexSizeLabel: formatBytes(row.index_bytes),
    })),
    attendanceByMonth: attendanceGrowthResult.rows.map((row) => ({
      month: row.month,
      records: toNumber(row.records) || 0,
    })),
    wal: {
      directoryBytes: walDirectoryBytes,
      directorySizeLabel: formatBytes(walDirectoryBytes),
      maxWalBytes,
      maxWalSizeLabel: formatBytes(maxWalBytes),
      settings: walSettingsResult.rows.map((row) => ({
        name: row.name,
        setting: row.setting,
        unit: row.unit || "",
      })),
      stats:
        walStatsResult.rows[0] && !walStatsResult.error
          ? {
              walRecords: toNumber(walStatsResult.rows[0].wal_records) || 0,
              walFpi: toNumber(walStatsResult.rows[0].wal_fpi) || 0,
              walBytes: toNumber(walStatsResult.rows[0].wal_bytes) || 0,
              walBytesLabel: formatBytes(walStatsResult.rows[0].wal_bytes),
              statsReset: walStatsResult.rows[0].stats_reset || null,
            }
          : null,
      error: walDirectoryResult.error || walStatsResult.error || null,
    },
    replication: {
      slots: replicationSlotsResult.rows.map((row) => ({
        slotName: row.slot_name,
        slotType: row.slot_type,
        active: Boolean(row.active),
        retainedBytes: toNumber(row.retained_bytes),
        retainedSizeLabel: formatBytes(row.retained_bytes),
        restartLsn: row.restart_lsn || null,
        confirmedFlushLsn: row.confirmed_flush_lsn || null,
      })),
      connections: replicationStatusResult.rows.map((row) => ({
        applicationName: row.application_name || "unknown",
        clientAddress: row.client_addr || null,
        state: row.state || null,
        syncState: row.sync_state || null,
        lagBytes: toNumber(row.lag_bytes),
        lagSizeLabel: formatBytes(row.lag_bytes),
      })),
    },
    vacuumCandidates: vacuumCandidatesResult.rows.map((row) => ({
      tableName: row.table_name,
      liveRows: toNumber(row.live_rows) || 0,
      deadRows: toNumber(row.dead_rows) || 0,
      deadPercent: toNumber(row.dead_pct),
      lastAutovacuum: row.last_autovacuum || null,
    })),
  };
};

const buildInfrastructureSnapshot = async () => {
  const [
    disk,
    metadata,
    remoteEc2,
  ] = await Promise.all([
    getDiskSnapshot(),
    fetchEc2Metadata(),
    loadRemoteEc2Snapshot(),
  ]);

  const totalMemoryBytes = os.totalmem();
  const freeMemoryBytes = os.freemem();
  const usedMemoryBytes = totalMemoryBytes - freeMemoryBytes;
  const processMemory = process.memoryUsage();
  const remoteConfigured = Boolean(remoteEc2?.remoteConfigured);
  const remoteCpuPercent = toNumber(remoteEc2?.cpuUtilization);

  return {
    summary: {
      hostname: remoteConfigured
        ? remoteEc2.instanceName || remoteEc2.publicHost || remoteEc2.instanceId
        : os.hostname(),
      platform: remoteConfigured ? "ec2-remote" : os.platform(),
      release: remoteConfigured ? null : os.release(),
      architecture: remoteConfigured ? null : os.arch(),
      uptimeSeconds: remoteConfigured ? null : os.uptime(),
      loadAverage: remoteConfigured ? [] : os.loadavg(),
      cpuCoreCount: remoteConfigured ? null : os.cpus().length,
      totalMemoryBytes: remoteConfigured ? null : totalMemoryBytes,
      freeMemoryBytes: remoteConfigured ? null : freeMemoryBytes,
      usedMemoryBytes: remoteConfigured ? null : usedMemoryBytes,
      usedMemoryPercent: remoteConfigured ? null : safePercent(usedMemoryBytes, totalMemoryBytes),
      totalMemoryLabel: remoteConfigured ? "Unavailable" : formatBytes(totalMemoryBytes),
      freeMemoryLabel: remoteConfigured ? "Unavailable" : formatBytes(freeMemoryBytes),
      usedMemoryLabel: remoteConfigured ? "Unavailable" : formatBytes(usedMemoryBytes),
      processRssBytes: remoteConfigured ? null : processMemory.rss,
      processHeapUsedBytes: remoteConfigured ? null : processMemory.heapUsed,
      processRssLabel: remoteConfigured ? "Unavailable" : formatBytes(processMemory.rss),
      processHeapUsedLabel: remoteConfigured ? "Unavailable" : formatBytes(processMemory.heapUsed),
      remoteConfigured,
      metricSource: remoteConfigured ? "remote-ec2" : "local-runtime",
      remoteCpuPercent,
      remoteCpuLabel: remoteConfigured ? formatPercent(remoteCpuPercent) : null,
    },
    disk: disk
      ? {
        ...disk,
          totalSizeLabel: remoteConfigured ? "Unavailable" : formatBytes(disk.totalBytes),
          usedSizeLabel: remoteConfigured ? "Unavailable" : formatBytes(disk.usedBytes),
          availableSizeLabel: remoteConfigured ? "Unavailable" : formatBytes(disk.availableBytes),
          usedPercent: remoteConfigured ? null : disk.usedPercent,
          note: remoteConfigured
            ? "Remote EC2 disk usage needs CloudWatch agent or instance-side collector."
            : disk.note,
        }
      : null,
    ec2: metadata,
    remoteEc2,
  };
};

const buildAlerts = ({ database, infrastructure }) => {
  const alerts = [];
  const remoteConfigured = Boolean(infrastructure.summary?.remoteConfigured);
  const remoteEc2 = infrastructure.remoteEc2 || null;

  const diskUsedPercent = remoteConfigured ? null : infrastructure.disk?.usedPercent;
  if (diskUsedPercent !== null && diskUsedPercent !== undefined) {
    if (diskUsedPercent >= 90) {
      alerts.push(
        buildAlert({
          severity: "critical",
          source: "ec2",
          title: "Disk pressure is critical",
          message: `Root volume is ${diskUsedPercent}% full. Immediate cleanup or expansion is required.`,
          metric: "disk_used_percent",
          current: diskUsedPercent,
          threshold: 90,
        })
      );
    } else if (diskUsedPercent >= 75) {
      alerts.push(
        buildAlert({
          severity: "warning",
          source: "ec2",
          title: "Disk usage is rising",
          message: `Root volume has reached ${diskUsedPercent}% usage.`,
          metric: "disk_used_percent",
          current: diskUsedPercent,
          threshold: 75,
        })
      );
    }
  }

  const memoryUsedPercent = remoteConfigured
    ? null
    : infrastructure.summary.usedMemoryPercent;
  if (memoryUsedPercent !== null && memoryUsedPercent !== undefined) {
    if (memoryUsedPercent >= 92) {
      alerts.push(
        buildAlert({
          severity: "critical",
          source: "ec2",
          title: "Server memory is saturated",
          message: `Instance memory usage is ${memoryUsedPercent}%.`,
          metric: "memory_used_percent",
          current: memoryUsedPercent,
          threshold: 92,
        })
      );
    } else if (memoryUsedPercent >= 82) {
      alerts.push(
        buildAlert({
          severity: "warning",
          source: "ec2",
          title: "Server memory is elevated",
          message: `Instance memory usage is ${memoryUsedPercent}%.`,
          metric: "memory_used_percent",
          current: memoryUsedPercent,
          threshold: 82,
        })
      );
    }
  }

  if (remoteConfigured) {
    const cpuUtilization = toNumber(remoteEc2?.cpuUtilization);
    if (cpuUtilization !== null) {
      if (cpuUtilization >= 90) {
        alerts.push(
          buildAlert({
            severity: "critical",
            source: "ec2",
            title: "Remote EC2 CPU is saturated",
            message: `${remoteEc2?.instanceName || remoteEc2?.instanceId} CPU utilization is ${cpuUtilization.toFixed(1)}%.`,
            metric: "ec2_cpu_percent",
            current: Number(cpuUtilization.toFixed(1)),
            threshold: 90,
          })
        );
      } else if (cpuUtilization >= 75) {
        alerts.push(
          buildAlert({
            severity: "warning",
            source: "ec2",
            title: "Remote EC2 CPU is elevated",
            message: `${remoteEc2?.instanceName || remoteEc2?.instanceId} CPU utilization is ${cpuUtilization.toFixed(1)}%.`,
            metric: "ec2_cpu_percent",
            current: Number(cpuUtilization.toFixed(1)),
            threshold: 75,
          })
        );
      }
    }

    if (
      remoteEc2 &&
      ((toNumber(remoteEc2.statusCheckFailedInstance) || 0) > 0 ||
        (toNumber(remoteEc2.statusCheckFailedSystem) || 0) > 0 ||
        (remoteEc2.instanceCheckStatus &&
          remoteEc2.instanceCheckStatus !== "ok") ||
        (remoteEc2.systemCheckStatus && remoteEc2.systemCheckStatus !== "ok"))
    ) {
      alerts.push(
        buildAlert({
          severity: "critical",
          source: "ec2",
          title: "Remote EC2 status checks are failing",
          message: `${remoteEc2.instanceName || remoteEc2.instanceId} has impaired EC2 checks.`,
          metric: "ec2_status_checks",
          current: `${remoteEc2.instanceCheckStatus || "unknown"}/${remoteEc2.systemCheckStatus || "unknown"}`,
          threshold: "ok/ok",
        })
      );
    }
  }

  const connectionUsagePercent = database.summary.connectionUsagePercent;
  if (connectionUsagePercent !== null && connectionUsagePercent !== undefined) {
    if (connectionUsagePercent >= 90) {
      alerts.push(
        buildAlert({
          severity: "critical",
          source: "database",
          title: "Database connections are near limit",
          message: `${database.summary.totalConnections}/${database.summary.maxConnections} connections are in use.`,
          metric: "db_connections_percent",
          current: connectionUsagePercent,
          threshold: 90,
        })
      );
    } else if (connectionUsagePercent >= 75) {
      alerts.push(
        buildAlert({
          severity: "warning",
          source: "database",
          title: "Database connection pool is busy",
          message: `${database.summary.totalConnections}/${database.summary.maxConnections} connections are in use.`,
          metric: "db_connections_percent",
          current: connectionUsagePercent,
          threshold: 75,
        })
      );
    }
  }

  const configuredUsagePercent = database.summary.configuredUsagePercent;
  if (configuredUsagePercent !== null && configuredUsagePercent !== undefined) {
    if (configuredUsagePercent >= 92) {
      alerts.push(
        buildAlert({
          severity: "critical",
          source: "database",
          title: "Database allocated storage is nearly full",
          message: `${database.summary.estimatedFootprintSizeLabel} of ${database.summary.configuredStorageSizeLabel} is already consumed.`,
          metric: "db_storage_percent",
          current: configuredUsagePercent,
          threshold: 92,
        })
      );
    } else if (configuredUsagePercent >= 80) {
      alerts.push(
        buildAlert({
          severity: "warning",
          source: "database",
          title: "Database storage is getting tight",
          message: `${database.summary.estimatedFootprintSizeLabel} of ${database.summary.configuredStorageSizeLabel} is already consumed.`,
          metric: "db_storage_percent",
          current: configuredUsagePercent,
          threshold: 80,
        })
      );
    }
  }

  const walDirectoryBytes = database.wal.directoryBytes;
  const maxWalBytes = database.wal.maxWalBytes;
  if (walDirectoryBytes !== null) {
    if (maxWalBytes && walDirectoryBytes >= maxWalBytes) {
      alerts.push(
        buildAlert({
          severity: "critical",
          source: "database",
          title: "WAL directory exceeded configured ceiling",
          message: `WAL files are using ${formatBytes(walDirectoryBytes)} against configured max_wal_size ${formatBytes(maxWalBytes)}.`,
          metric: "wal_directory_bytes",
          current: walDirectoryBytes,
          threshold: maxWalBytes,
        })
      );
    } else if (walDirectoryBytes >= 10 * 1024 * 1024 * 1024) {
      alerts.push(
        buildAlert({
          severity: "warning",
          source: "database",
          title: "WAL directory is large",
          message: `WAL files are using ${formatBytes(walDirectoryBytes)}.`,
          metric: "wal_directory_bytes",
          current: walDirectoryBytes,
          threshold: 10 * 1024 * 1024 * 1024,
        })
      );
    }
  }

  database.replication.slots.forEach((slot) => {
    if (!slot.retainedBytes) return;
    if (!slot.active && slot.retainedBytes >= 5 * 1024 * 1024 * 1024) {
      alerts.push(
        buildAlert({
          severity: "critical",
          source: "database",
          title: "Inactive replication slot is retaining WAL",
          message: `${slot.slotName} is inactive but still retaining ${slot.retainedSizeLabel}.`,
          metric: "replication_slot_retained_bytes",
          current: slot.retainedBytes,
          threshold: 5 * 1024 * 1024 * 1024,
        })
      );
    } else if (slot.retainedBytes >= 1024 * 1024 * 1024) {
      alerts.push(
        buildAlert({
          severity: "warning",
          source: "database",
          title: "Replication slot is retaining significant WAL",
          message: `${slot.slotName} is retaining ${slot.retainedSizeLabel}.`,
          metric: "replication_slot_retained_bytes",
          current: slot.retainedBytes,
          threshold: 1024 * 1024 * 1024,
        })
      );
    }
  });

  database.vacuumCandidates.forEach((table) => {
    if ((table.deadPercent || 0) >= 20 && table.deadRows >= 10000) {
      alerts.push(
        buildAlert({
          severity: "warning",
          source: "database",
          title: "Table bloat needs attention",
          message: `${table.tableName} has ${numberFormatter.format(table.deadRows)} dead rows (${table.deadPercent}% bloat).`,
          metric: "dead_tuple_percent",
          current: table.deadPercent,
          threshold: 20,
        })
      );
    }
  });

  if (!database.connectivity.ok) {
    alerts.push(
      buildAlert({
        severity: "critical",
        source: "database",
        title: "Database connectivity failed",
        message: database.connectivity.error || "Monitoring query could not connect to PostgreSQL.",
      })
    );
  }

  if (!remoteConfigured && infrastructure.ec2?.unavailable) {
    alerts.push(
      buildAlert({
        severity: "info",
        source: "ec2",
        title: "EC2 metadata is unavailable",
        message: "Metadata service did not respond. This is expected in local development.",
      })
    );
  }

  if (remoteConfigured && remoteEc2?.metricsUnavailable) {
    alerts.push(
      buildAlert({
        severity: "info",
        source: "ec2",
        title: "Remote EC2 metrics are unavailable",
        message:
          remoteEc2.metricsReason ||
          "CloudWatch metrics could not be loaded for the configured EC2 instance.",
      })
    );
  }

  return alerts;
};

const getSystemHealthSnapshot = async () => {
  const client = await pool.connect();
  try {
    const [databaseResult, infrastructureResult, rdsStorageResult] =
      await Promise.allSettled([
        buildDatabaseSnapshot(client),
        buildInfrastructureSnapshot(),
        loadRdsStorageSnapshot(),
      ]);

    const database =
      databaseResult.status === "fulfilled"
        ? databaseResult.value
        : {
            connectivity: {
              ok: false,
              error: databaseResult.reason?.message || "Database snapshot failed.",
            },
            summary: {
              databaseName: process.env.DB_NAME || "DB",
              postgresVersion: null,
              totalBytes: null,
              totalSizeLabel: "N/A",
              relationTableBytes: 0,
              relationIndexBytes: 0,
              relationTotalBytes: 0,
              relationTableSizeLabel: "N/A",
              relationIndexSizeLabel: "N/A",
              relationTotalSizeLabel: "N/A",
              estimatedFootprintBytes: 0,
              estimatedFootprintSizeLabel: "N/A",
              configuredStorageBytes: resolveConfiguredStorageBytes(),
              configuredStorageSizeLabel: formatBytes(resolveConfiguredStorageBytes()),
              estimatedFreeStorageBytes: null,
              estimatedFreeStorageSizeLabel: "N/A",
              configuredUsagePercent: null,
              connectionUsagePercent: null,
              totalConnections: 0,
              activeConnections: 0,
              waitingConnections: 0,
              maxConnections: 0,
              actualUsedStorageBytes: 0,
              actualUsedStorageSizeLabel: "N/A",
              storageTelemetrySource: "snapshot-error",
            },
            tables: [],
            indexes: [],
            attendanceByYear: [],
            wal: {
              directoryBytes: null,
              directorySizeLabel: "N/A",
              maxWalBytes: null,
              maxWalSizeLabel: "N/A",
              settings: [],
              stats: null,
              error: databaseResult.reason?.message || "Database snapshot failed.",
            },
            replication: {
              slots: [],
              connections: [],
            },
            vacuumCandidates: [],
          };

    const infrastructure =
      infrastructureResult.status === "fulfilled"
        ? infrastructureResult.value
        : {
            summary: {
              hostname: "Unavailable",
              platform: "unavailable",
              release: null,
              architecture: null,
              uptimeSeconds: null,
              loadAverage: [],
              cpuCoreCount: null,
              totalMemoryBytes: null,
              freeMemoryBytes: null,
              usedMemoryBytes: null,
              usedMemoryPercent: null,
              totalMemoryLabel: "Unavailable",
              freeMemoryLabel: "Unavailable",
              usedMemoryLabel: "Unavailable",
              processRssBytes: null,
              processHeapUsedBytes: null,
              processRssLabel: "Unavailable",
              processHeapUsedLabel: "Unavailable",
              remoteConfigured: false,
              metricSource: "snapshot-error",
              remoteCpuPercent: null,
              remoteCpuLabel: null,
            },
            disk: null,
            ec2: {
              unavailable: true,
              reason:
                infrastructureResult.reason?.message ||
                "Infrastructure snapshot failed.",
            },
            remoteEc2: null,
          };

    const rdsStorage =
      rdsStorageResult.status === "fulfilled" ? rdsStorageResult.value : null;

    if (rdsStorage && !rdsStorage.unavailable) {
      const allocatedBytes = toNumber(rdsStorage.allocatedStorageBytes);
      const usedBytes = toNumber(rdsStorage.usedStorageBytes);
      const freeBytes = toNumber(rdsStorage.freeStorageBytes);

      database.summary.configuredStorageBytes =
        allocatedBytes || database.summary.configuredStorageBytes;
      database.summary.configuredStorageSizeLabel = formatBytes(
        database.summary.configuredStorageBytes
      );
      database.summary.actualUsedStorageBytes =
        usedBytes !== null ? usedBytes : database.summary.estimatedFootprintBytes;
      database.summary.actualUsedStorageSizeLabel = formatBytes(
        database.summary.actualUsedStorageBytes
      );
      database.summary.estimatedFreeStorageBytes =
        freeBytes !== null ? freeBytes : database.summary.estimatedFreeStorageBytes;
      database.summary.estimatedFreeStorageSizeLabel = formatBytes(
        database.summary.estimatedFreeStorageBytes
      );
      database.summary.configuredUsagePercent =
        allocatedBytes && usedBytes !== null
          ? safePercent(usedBytes, allocatedBytes)
          : database.summary.configuredUsagePercent;
      database.summary.storageTelemetrySource = "aws-rds";
      database.rds = {
        dbInstanceIdentifier: rdsStorage.dbInstanceIdentifier,
        dbInstanceClass: rdsStorage.dbInstanceClass,
        engine: rdsStorage.engine,
        multiAz: rdsStorage.multiAz,
        region: rdsStorage.region,
        allocatedStorageBytes: allocatedBytes,
        allocatedStorageSizeLabel: formatBytes(allocatedBytes),
        freeStorageBytes: freeBytes,
        freeStorageSizeLabel: formatBytes(freeBytes),
        usedStorageBytes: usedBytes,
        usedStorageSizeLabel: formatBytes(usedBytes),
      };
    } else {
      database.summary.actualUsedStorageBytes =
        database.summary.estimatedFootprintBytes;
      database.summary.actualUsedStorageSizeLabel = formatBytes(
        database.summary.actualUsedStorageBytes
      );
      database.summary.storageTelemetrySource = database.summary.configuredStorageBytes
        ? "env-config"
        : "database-estimate";
      if (rdsStorage?.unavailable) {
        database.rds = {
          unavailable: true,
          reason: rdsStorage.reason,
        };
      }
    }

    const alerts = buildAlerts({ database, infrastructure });
    const overallStatus = determineOverallStatus(alerts);

    return {
      generatedAt: new Date().toISOString(),
      summary: {
        overallStatus,
        alertCount: alerts.length,
        criticalCount: alerts.filter((alert) => alert.severity === "critical").length,
        warningCount: alerts.filter((alert) => alert.severity === "warning").length,
      },
      alerts,
      database,
      infrastructure,
    };
  } finally {
    client.release();
  }
};

module.exports = {
  getSystemHealthSnapshot,
  formatBytes,
};
