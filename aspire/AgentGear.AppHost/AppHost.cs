var builder = DistributedApplication.CreateBuilder(args);

// 敏感参数：优先使用配置注入（`Parameters:<name>` / 环境变量 `Parameters__<name>`），
// 否则每次启动随机生成——绝不提交字面量默认值（问题 4/47，CWE-798）。
string SecretOrDefault(string name, int bytes = 32)
{
    var configured = builder.Configuration[$"Parameters:{name}"];
    if (!string.IsNullOrWhiteSpace(configured))
    {
        return configured;
    }
    return Convert.ToBase64String(System.Security.Cryptography.RandomNumberGenerator.GetBytes(bytes))
        .Replace("+", string.Empty)
        .Replace("/", string.Empty)
        .Replace("=", string.Empty);
}

var compose = builder.AddDockerComposeEnvironment("z-agent-gear")
    .WithProperties(env =>
    {
        env.DashboardEnabled = false;
    })
    .ConfigureComposeFile(composeFile =>
    {
        composeFile.Services.Remove("agent-controller");
    });

var mongodb = builder.AddMongoDB("mongodb")
    .WithImage("mongo", "7")
    .PublishAsDockerComposeService((resource, service) =>
    {
        service.Name = "mongodb";
        service.Image = "registry.cn-hangzhou.aliyuncs.com/zero-tools/mongo:7";
    });

if (builder.ExecutionContext.IsPublishMode)
{
    mongodb = mongodb.WithDataVolume();
}

var redis = builder.AddRedis("redis")
    .PublishAsDockerComposeService((resource, service) =>
    {
        service.Name = "redis";
        service.Image = "registry.cn-hangzhou.aliyuncs.com/zero-tools/redis:8.6";
    });

// 计费事件骨干（费用中心）：topic exchange + 重试/DLQ；本地 dev 与 compose 均复用同一 RabbitMQ。
var rabbitmq = builder.AddRabbitMQ("rabbitmq")
    .PublishAsDockerComposeService((resource, service) =>
    {
        service.Name = "rabbitmq";
        service.Image = "rabbitmq:3-management";
    });

var corsOrigin = builder.AddParameter("cors-origin");
var mcpJwtSecret = builder.AddParameter("mcp-jwt-secret", secret: true, value: SecretOrDefault("mcp-jwt-secret"));
var jwtSecret = builder.AddParameter("jwt-secret", secret: true, value: SecretOrDefault("jwt-secret"));
var adminJwtSecret = builder.AddParameter("admin-jwt-secret", secret: true, value: SecretOrDefault("admin-jwt-secret"));
var credentialEncryptionKey = builder.AddParameter("credential-encryption-key", secret: true, value: "0000000000000000000000000000000000000000000000000000000000000000");
// admin-api 首次种子管理员初始密码（问题 4/47）：不再提交任何字面量默认值——
// 每次启动随机生成（admin-api 首次种子时一次性打印到日志），或经配置 `Parameters:admin-initial-password` 注入。
var adminInitialPassword = builder.AddParameter("admin-initial-password", secret: true, value: SecretOrDefault("admin-initial-password", 18));
var githubAppId = builder.AddParameter("github-app-id", value: "4253594");
var githubAppUrl = builder.AddParameter("github-app-url", value: "https://github.com/apps/z-agent-bot-test");
var githubSetupUrl = builder.AddParameter("github-setup-url", value: "http://localhost:10001/api/github/setup");
var githubTokenEncryptionKey = builder.AddParameter("github-token-encryption-key", secret: true, value: SecretOrDefault("github-token-encryption-key"));
var githubAppPrivateKeyPath = Path.Combine(AppContext.BaseDirectory, "github-app-private-key.pem");
var githubAppPrivateKeyValue = File.Exists(githubAppPrivateKeyPath) ? File.ReadAllText(githubAppPrivateKeyPath) : "";
var githubAppPrivateKey = builder.AddParameter("github-app-private-key", secret: true, value: githubAppPrivateKeyValue);

var controllerApi = builder.AddNodeApp("controller-api", "../../servers/controller-api", "src/index.ts")
    .WithEnvironment("NODE_OPTIONS", "--import tsx")
    .WithHttpEndpoint(env: "PORT")
    .WithReference(mongodb)
    .WithReference(redis)
    .WithExternalHttpEndpoints()
    .PublishAsDockerComposeService((resource, service) =>
    {
        service.Name = "controller-api";
        service.Restart = "unless-stopped";
    });

var agentApi = builder.AddNodeApp("agent-api", "../../servers/agent-api", "src/index.ts")
    .WithEnvironment("NODE_OPTIONS", "--import tsx")
    .WithEnvironment("CORS_ORIGIN", corsOrigin)
    .WithEnvironment("JWT_SECRET", jwtSecret)
    .WithEnvironment("MCP_ENDPOINT_JWT_SECRET", mcpJwtSecret)
    .WithEnvironment("GITHUB_APP_ID", githubAppId)
    .WithEnvironment("GITHUB_APP_URL", githubAppUrl)
    .WithEnvironment("GITHUB_SETUP_URL", githubSetupUrl)
    .WithEnvironment("GITHUB_APP_PRIVATE_KEY", githubAppPrivateKey)
    .WithEnvironment("GITHUB_TOKEN_ENCRYPTION_KEY", githubTokenEncryptionKey)
    .WithReference(mongodb)
    .WithReference(redis)
    .WithExternalHttpEndpoints()
    .PublishAsDockerComposeService((resource, service) =>
    {
        service.Name = "agent-api";
        service.Restart = "unless-stopped";
    });

var internalApiToken = builder.AddParameter("internal-api-token", secret: true, value: SecretOrDefault("internal-api-token"));
var workerImage = builder.AddParameter("worker-image", value: "core.harbor.internal.fffdan.com/zag/worker:latest");
var publicWsEndpoint = builder.AddParameter("public-ws-endpoint", value: "localhost:10004");
// admin-web 运行在浏览器，需要一个可达的 admin-api 地址（容器运行时注入 config.js，见 40-generate-config-js.sh）
var adminApiUrl = builder.AddParameter("admin-api-url", value: "http://localhost:8002");

// cloud-controller / admin-api 的发布镜像已构建为 dist（见各自 Dockerfile），
// 运行时不依赖 tsx；NODE_OPTIONS=--import tsx 仅在本地 dev（直跑 TS 源码）时注入。
var cloudController = builder.AddNodeApp("cloud-controller", "../../servers/cloud-controller", "src/index.ts")
    .WithEnvironment("INTERNAL_API_TOKEN", internalApiToken)
    .WithEnvironment("K8S_NAMESPACE", "zag-cloud")
    .WithEnvironment("WORKER_IMAGE", workerImage)
    .WithEnvironment("PUBLIC_WS_ENDPOINT", publicWsEndpoint)
    // 工作负载（可选，代码内已有默认值，此处显式声明便于本地调参）
    .WithEnvironment("WORKLOAD_INIT_TIMEOUT_MS", "300000")
    .WithEnvironment("WORKLOAD_POST_BUDGET_MS", "90000")
    .WithEnvironment("WORKLOAD_LOG_MAX_BYTES", "262144")
    // 本地开发默认不依赖真实集群（InMemoryK8sClient）；publish 覆盖为 true
    .WithEnvironment("K8S_ENABLED", "false")
    .WithReference(mongodb)
    .WithExternalHttpEndpoints()
    .PublishAsDockerComposeService((resource, service) =>
    {
        service.Name = "cloud-controller";
        service.Restart = "unless-stopped";
    });
cloudController.WithReference(rabbitmq);

var agentController = builder.AddNodeApp("agent-controller", "../../packages/agent-controller", "src/index.ts")
    .WithEnvironment("NODE_OPTIONS", "--import tsx")
    .WithEnvironment("ZAG_SERVER_ENDPOINT", controllerApi.GetEndpoint("http"))
    .WithExplicitStart()
    .WaitFor(controllerApi)
    .ExcludeFromManifest();

var adminApi = builder.AddNodeApp("admin-api", "../../servers/admin-api", "src/index.ts")
    .WithEnvironment("ADMIN_JWT_SECRET", adminJwtSecret)
    .WithEnvironment("CREDENTIAL_ENCRYPTION_KEY", credentialEncryptionKey)
    .WithEnvironment("ADMIN_INITIAL_PASSWORD", adminInitialPassword)
    .WithEnvironment("CORS_ORIGIN", corsOrigin)
    .WithEnvironment("CLOUD_CONTROLLER_URL", cloudController.GetEndpoint("http"))
    .WithEnvironment("INTERNAL_API_TOKEN", internalApiToken)
    // 销毁容器超时（工作负载清理脚本批次需 > post 预算 90s + 宽限 10s + 删 Job 重试）
    .WithEnvironment("CLOUD_CONTROLLER_DESTROY_TIMEOUT_MS", "180000")
    .WithReference(mongodb)
    .WithExternalHttpEndpoints()
    .PublishAsDockerComposeService((resource, service) =>
    {
        service.Name = "admin-api";
        service.Restart = "unless-stopped";
    });
adminApi.WithReference(rabbitmq);

if (!builder.ExecutionContext.IsPublishMode)
{
    // 本地 dev 直跑 TS 源码，需要 tsx 加载器
    cloudController.WithEnvironment("NODE_OPTIONS", "--import tsx");
    adminApi.WithEnvironment("NODE_OPTIONS", "--import tsx");

    var agentWeb = builder.AddViteApp("agent-web", "../../apps/agent-web")
        .WithEnvironment("VITE_CONTROLLER_API_URL", controllerApi.GetEndpoint("http"))
        .WithEnvironment("VITE_API_URL", agentApi.GetEndpoint("http"))
        .WithReference(agentApi)
        .PublishAsDockerComposeService((resource, service) =>
        {
            service.Name = "agent-web";
        });
    agentApi.WithEnvironment("FRONTEND_URL", agentWeb.GetEndpoint("http"))
        .WithEnvironment("ADMIN_API_URL", adminApi.GetEndpoint("http"))
        .WithEnvironment("INTERNAL_API_TOKEN", internalApiToken)
        .WithHttpEndpoint(port: 10001, env: "PORT");

    adminApi.WithHttpEndpoint(port: 10003, env: "PORT");
    cloudController.WithHttpEndpoint(port: 10004, env: "PORT");
    var adminWeb = builder.AddViteApp("admin-web", "../../apps/admin-web")
        .WithEnvironment("VITE_ADMIN_API_URL", adminApi.GetEndpoint("http"));
}
else
{
    agentApi.WithEnvironment("FRONTEND_URL", builder.AddParameter("frontend-url"))
        .WithEnvironment("ADMIN_API_URL", adminApiUrl)
        .WithEnvironment("INTERNAL_API_TOKEN", internalApiToken)
        .WithHttpEndpoint(port: 8000, env: "PORT")
        .WithExternalHttpEndpoints();

    controllerApi
        .WithHttpEndpoint(port: 8001, env: "PORT")
        .WithExternalHttpEndpoints();

    adminApi
        .WithHttpEndpoint(port: 8002, env: "PORT")
        .WithExternalHttpEndpoints();

    cloudController
        .WithEnvironment("K8S_ENABLED", "true")
        .WithHttpEndpoint(port: 8003, env: "PORT")
        .WithExternalHttpEndpoints();

    // admin-web 使用自身 Dockerfile 构建镜像（node 构建 + nginx 托管），
    // publish 时镜像名参数化为 ${ADMIN_WEB_IMAGE}，与 AGENT_API_IMAGE/CONTROLLER_API_IMAGE 一致
    builder.AddDockerfile("admin-web", "../../apps/admin-web")
        .WithEnvironment("ADMIN_API_URL", adminApiUrl)
        .WithHttpEndpoint(port: 80, targetPort: 80)
        .WithExternalHttpEndpoints()
        .PublishAsDockerComposeService((resource, service) =>
        {
            service.Name = "admin-web";
            service.Restart = "unless-stopped";
        });
}

builder.Build().Run();
