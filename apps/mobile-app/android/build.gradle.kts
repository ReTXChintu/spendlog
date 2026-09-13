allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
subprojects {
    project.evaluationDependsOn(":app")
}

// Plugins in the dependency tree target a mix of JVM versions - one
// compiles Kotlin to 1.8 with Java at 11, another puts both at 17 - and
// Gradle fails any module whose Java and Kotlin targets disagree.
//
// Rather than impose one number on everyone, take whatever Java level the
// module settled on and give its Kotlin the same one. The lookup happens
// inside configureEach, which runs once every project has been evaluated,
// so it reads the value after the plugin's own build script has had its
// say - an ordering that setting the Java level from here cannot win.
subprojects {
    tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
        val java = (project.extensions.findByName("android") as? com.android.build.gradle.BaseExtension)
            ?.compileOptions
            ?.targetCompatibility
            ?.toString()
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.fromTarget(java ?: "17"))
        }
    }
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
