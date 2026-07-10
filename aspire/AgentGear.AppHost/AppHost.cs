var builder = DistributedApplication.CreateBuilder(args);

var compose = builder.AddDockerComposeEnvironment("z-agent-gear")
    .WithProperties(env =>
    {
        env.DashboardEnabled = false;
    })
    .ConfigureComposeFile(composeFile =>
    {
        composeFile.Services.Remove("agent-controller");
        composeFile.Services.Remove("agent-web");
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
var githubAppId = builder.AddParameter("github-app-id", value: "4253594");
var githubAppUrl = builder.AddParameter("github-app-url", value: "https://github.com/apps/z-agent-bot-test");
var githubSetupUrl = builder.AddParameter("github-setup-url", value: "http://localhost:10001/api/github/setup");
var githubTokenEncryptionKey = builder.AddParameter("github-token-encryption-key", secret: true, value: "0000000000000000000000000000000000000000000000000000000000000000");
var githubAppPrivateKeyPath = Path.Combine(AppContext.BaseDirectory, "github-app-private-key.pem");
var githubAppPrivateKeyValue = File.Exists(githubAppPrivateKeyPath) ? File.ReadAllText(githubAppPrivateKeyPath) : "";
var githubAppPrivateKey = builder.AddParameter("github-app-private-key", secret: true, value: githubAppPrivateKeyValue);

var controllerApi = builder.AddNodeApp("controller-api", "../../servers/controller-api", "src/index.ts")
    .WithEnvironment("NODE_OPTIONS", "--import tsx")
    .WithEnvironment("MCP_ENDPOINT_JWT_SECRET", mcpJwtSecret)
    .WithHttpEndpoint(env: "PORT")
    .WithReference(mongodb)
    .WithReference(redis)
    .WithExternalHttpEndpoints()
    .PublishAsDockerComposeService((resource, service) =>
    {
        service.Name = "controller-api";
        service.Restart = "unless-stopped";
        service.Ports = [.. service.Ports.Select(p => $"{p}:{p}")];
    });

var agentWeb = builder.AddViteApp("agent-web", "../../apps/agent-web")
    .WithEnvironment("VITE_CONTROLLER_API_URL", controllerApi.GetEndpoint("http"))
    .WithEnvironment("MCP_ENDPOINT_JWT_SECRET", mcpJwtSecret);

var agentApi = builder.AddNodeApp("agent-api", "../../servers/agent-api", "src/index.ts")
    .WithEnvironment("NODE_OPTIONS", "--import tsx")
    .WithEnvironment("CORS_ORIGIN", corsOrigin)
    .WithEnvironment("JWT_SECRET", jwtSecret)
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
        service.Ports = [.. service.Ports.Select(p => $"{p}:{p}")];
    });

if (builder.ExecutionContext.IsPublishMode)
{
    var frontendEndpoint = builder.AddParameter("frontend-endpoint");
    agentApi.WithEnvironment("FRONTEND_URL", frontendEndpoint)
    .WithHttpEndpoint(env: "PORT");
}
else
{
    agentApi.WithEnvironment("FRONTEND_URL", agentWeb.GetEndpoint("http"))
    .WithHttpEndpoint(10001, env: "PORT");
}

agentWeb
    .WithEnvironment("VITE_API_URL", agentApi.GetEndpoint("http"))
    .WithReference(agentApi);

var agentController = builder.AddNodeApp("agent-controller", "../../packages/agent-controller", "src/index.ts")
    .WithEnvironment("NODE_OPTIONS", "--import tsx")
    .WithEnvironment("ZAG_SERVER_ENDPOINT", controllerApi.GetEndpoint("http"))
    .WithExplicitStart()
    .WaitFor(controllerApi)
    .ExcludeFromManifest();

builder.Build().Run();
