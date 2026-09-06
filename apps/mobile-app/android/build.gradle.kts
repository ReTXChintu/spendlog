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

// Plugins in the dependency tree target a mix of JVM versions — for
// example another_telephony compiles Kotlin to 1.8 with Java at 11, while
// shared_preferences_android uses Java 17 — and Gradle fails any module
// whose Java and Kotlin targets disagree. Pin both to 17 everywhere so the
// combination is consistent regardless of what each plugin declares.
// The Java level comes from each module's `android` extension, so it has
// to be set there — configuring JavaCompile tasks directly is overridden
// by AGP. configureEach/withId are lazy, so this must not be wrapped in
// afterEvaluate: evaluationDependsOn(":app") above has already evaluated
// these projects by this point.
subprojects {
    plugins.withId("com.android.library") {
        extensions.configure<com.android.build.api.dsl.LibraryExtension>("android") {
            compileOptions {
                sourceCompatibility = JavaVersion.VERSION_17
                targetCompatibility = JavaVersion.VERSION_17
            }
        }
    }
    // Only libraries (the plugin modules) are adjusted — :app is already
    // evaluated by the time this runs, so its options are finalized. It
    // sets its own Java level in app/build.gradle.kts.
    tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
