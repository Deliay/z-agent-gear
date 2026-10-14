var builder = DistributedApplication.CreateBuilder(args);

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

var corsOrigin = builder.AddParameter("cors-origin");
var mcpJwtSecret = builder.AddParameter("mcp-jwt-secret", secret: true, value: "default-dev-secret-key-for-testing");
var jwtSecret = builder.AddParameter("jwt-secret", secret: true, value: "dev-jwt-secret-for-testing");
var adminJwtSecret = builder.AddParameter("admin-jwt-secret", secret: true, value: "dev-admin-secret-change-in-production");
var credentialEncryptionKey = builder.AddParameter("credential-encryption-key", secret: true, value: "0000000000000000000000000000000000000000000000000000000000000000");
var githubAppId = builder.AddParameter("github-app-id", value: "4253594");
var githubAppUrl = builder.AddParameter("github-app-url", value: "https://github.com/apps/z-agent-bot-test");
var githubSetupUrl = builder.AddParameter("github-setup-url", value: "http://localhost:10001/api/github/setup");
var githubTokenEncryptionKey = builder.AddParameter("github-token-encryption-key", secret: true, value: "0000000000000000000000000000000000000000000000000000000000000000");
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

var agentController = builder.AddNodeApp("agent-controller", "../../packages/agent-controller", "src/index.ts")
    .WithEnvironment("NODE_OPTIONS", "--import tsx")
    .WithEnvironment("ZAG_SERVER_ENDPOINT", controllerApi.GetEndpoint("http"))
    .WithExplicitStart()
    .WaitFor(controllerApi)
    .ExcludeFromManifest();

var adminApi = builder.AddNodeApp("admin-api", "../../servers/admin-api", "src/index.ts")
    .WithEnvironment("NODE_OPTIONS", "--import tsx")
    .WithEnvironment("ADMIN_JWT_SECRET", adminJwtSecret)
    .WithEnvironment("CREDENTIAL_ENCRYPTION_KEY", credentialEncryptionKey)
    .WithEnvironment("CORS_ORIGIN", corsOrigin)
    .WithReference(mongodb)
    .WithExternalHttpEndpoints()
    .PublishAsDockerComposeService((resource, service) =>
    {
        service.Name = "admin-api";
        service.Restart = "unless-stopped";
    });

if (!builder.ExecutionContext.IsPublishMode)
{
    var agentWeb = builder.AddViteApp("agent-web", "../../apps/agent-web")
        .WithEnvironment("VITE_CONTROLLER_API_URL", controllerApi.GetEndpoint("http"))
        .WithEnvironment("VITE_API_URL", agentApi.GetEndpoint("http"))
        .WithReference(agentApi)
        .PublishAsDockerComposeService((resource, service) =>
        {
            service.Name = "agent-web";
        });
    agentApi.WithEnvironment("FRONTEND_URL", agentWeb.GetEndpoint("http"))
        .WithHttpEndpoint(port: 10001, env: "PORT");

    adminApi.WithHttpEndpoint(port: 10003, env: "PORT");
    var adminWeb = builder.AddViteApp("admin-web", "../../apps/admin-web")
        .WithEnvironment("VITE_ADMIN_API_URL", adminApi.GetEndpoint("http"));
}
else
{
    agentApi.WithEnvironment("FRONTEND_URL", builder.AddParameter("frontend-url"))
        .WithHttpEndpoint(port: 8000, env: "PORT")
        .WithExternalHttpEndpoints();

    controllerApi
        .WithHttpEndpoint(port: 8001, env: "PORT")
        .WithExternalHttpEndpoints();

    adminApi
        .WithHttpEndpoint(port: 8002, env: "PORT")
        .WithExternalHttpEndpoints();

    // admin-web 使用自身 Dockerfile 构建镜像（node 构建 + nginx 托管），
    // publish 时镜像名参数化为 ${ADMIN_WEB_IMAGE}，与 AGENT_API_IMAGE/CONTROLLER_API_IMAGE 一致
    builder.AddDockerfile("admin-web", "../../apps/admin-web")
        .WithHttpEndpoint(port: 80, targetPort: 80)
        .WithExternalHttpEndpoints()
        .PublishAsDockerComposeService((resource, service) =>
        {
            service.Name = "admin-web";
            service.Restart = "unless-stopped";
        });
}

builder.Build().Run();
