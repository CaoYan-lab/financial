// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ChangFu",
    defaultLocalization: "zh-Hans",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "ChangFu", targets: ["ChangFuApp"]),
        .executable(name: "ChangFuBrokerHost", targets: ["BrokerHost"]),
        .executable(name: "ChangFuLongbridgeHost", targets: ["LongbridgeHost"]),
        .executable(name: "ChangFuDesktopTests", targets: ["ChangFuDesktopTests"])
    ],
    targets: [
        .target(
            name: "FutuCppBridge",
            path: "FutuCppBridge",
            publicHeadersPath: "include",
            cxxSettings: [
                .define("CHANGFU_FUTU_SDK_AVAILABLE"),
                .unsafeFlags([
                    "-I", "../../.data/changfu-sdk/third/include"
                ])
            ],
            linkerSettings: [
                .unsafeFlags([
                    "-L", "../../.data/changfu-sdk/third/lib",
                    "-lFTAPI",
                    "-lprotobuf",
                    "-lssl",
                    "-lcrypto",
                    "-lz"
                ]),
                .unsafeFlags([
                    "-Xlinker", "-rpath",
                    "-Xlinker", "../../.data/changfu-sdk/third/lib"
                ], .when(configuration: .debug)),
                .unsafeFlags([
                    "-Xlinker", "-rpath",
                    "-Xlinker", "@executable_path/../Frameworks"
                ], .when(configuration: .release))
            ]
        ),
        .target(
            name: "ChangFuBrokerNative",
            dependencies: ["ChangFuDomain", "FutuCppBridge"],
            path: "NativeBroker"
        ),
        .target(
            name: "ChangFuDomain",
            path: "Domain"
        ),
        .target(
            name: "ChangFuInfrastructure",
            dependencies: ["ChangFuDomain"],
            path: "Infrastructure"
        ),
        .executableTarget(
            name: "BrokerHost",
            dependencies: ["ChangFuDomain", "ChangFuBrokerNative"],
            path: "BrokerHost"
        ),
        .executableTarget(
            name: "LongbridgeHost",
            dependencies: ["ChangFuDomain"],
            path: "LongbridgeHost"
        ),
        .executableTarget(
            name: "ChangFuApp",
            dependencies: ["ChangFuDomain", "ChangFuInfrastructure"],
            path: "App"
        ),
        .executableTarget(
            name: "ChangFuDesktopTests",
            dependencies: ["ChangFuDomain", "ChangFuInfrastructure"],
            path: "TestRunner"
        )
    ],
    cxxLanguageStandard: .cxx17
)
