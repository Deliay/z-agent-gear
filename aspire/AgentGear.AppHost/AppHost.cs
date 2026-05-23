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
    .WithImage("registry.cn-hangzhou.aliyuncs.com/zero-tools/mongo:7")
    .WithDataVolume()
    .PublishAsDockerComposeService((resource, service) =>
    {
        service.Name = "mongodb";
        service.Image = "registry.cn-hangzhou.aliyuncs.com/zero-tools/mongo:7";
    });

var redis = builder.AddRedis("redis")
    .WithImage("registry.cn-hangzhou.aliyuncs.com/zero-tools/redis:8.6")
    .PublishAsDockerComposeService((resource, service) =>
    {
        service.Name = "redis";
        service.Image = "registry.cn-hangzhou.aliyuncs.com/zero-tools/redis:8.6";
    });

var agentApi = builder.AddNodeApp("agent-api", "../../servers/agent-api", "src/index.ts")
    .WithEnvironment("NODE_OPTIONS", "--import tsx")
    .WithHttpEndpoint(env: "PORT")
    .WithReference(mongodb)
    .WithReference(redis)
    .PublishAsDockerComposeService((resource, service) =>
    {
        service.Name = "agent-api";
        service.Restart = "unless-stopped";
    });

var controllerApi = builder.AddNodeApp("controller-api", "../../servers/controller-api", "src/index.ts")
    .WithEnvironment("NODE_OPTIONS", "--import tsx")
    .WithHttpEndpoint(env: "PORT")
    .WithReference(mongodb)
    .WithReference(redis)
    .PublishAsDockerComposeService((resource, service) =>
    {
        service.Name = "controller-api";
        service.Restart = "unless-stopped";
    });

var agentWeb = builder.AddViteApp("agent-web", "../../apps/agent-web")
    .WithReference(agentApi)
    .WithEnvironment("VITE_API_URL", agentApi.GetEndpoint("http"))
    .PublishAsDockerComposeService((resource, service) =>
    {
        service.Name = "agent-web";
    });

var agentController = builder.AddNodeApp("agent-controller", "../../packages/agent-controller", "src/index.ts")
    .WithEnvironment("NODE_OPTIONS", "--import tsx")
    .WithEnvironment("ZAG_SERVER_ENDPOINT", controllerApi.GetEndpoint("http"))
    .WithExplicitStart()
    .WaitFor(controllerApi)
    .ExcludeFromManifest();

builder.Build().Run();
