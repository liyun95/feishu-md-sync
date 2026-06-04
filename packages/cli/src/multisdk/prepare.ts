import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { MultisdkLanguage } from './language.js';

export type PrepareMultisdkVerifierInput = {
  taskDir: string;
  language: MultisdkLanguage;
  remoteMarkdownPath: string;
  snippetPaths: string[];
  milvusVersion: string;
};

export type PrepareMultisdkVerifierResult = {
  files: string[];
  command: string;
};

export async function prepareMultisdkVerifier(
  input: PrepareMultisdkVerifierInput
): Promise<PrepareMultisdkVerifierResult> {
  const workDir = join(input.taskDir, 'work', input.language);
  const snippetDir = join(workDir, 'snippets');
  const verifyDir = join(workDir, 'verify');
  await mkdir(snippetDir, { recursive: true });
  await mkdir(verifyDir, { recursive: true });

  const remoteMarkdown = await readFile(input.remoteMarkdownPath, 'utf8');
  const pythonContextPath = join(workDir, 'python-context.md');
  const snippetFiles: string[] = [];

  await writeFile(pythonContextPath, renderPythonContext(remoteMarkdown), 'utf8');
  for (const snippetPath of input.snippetPaths) {
    const target = join(snippetDir, basename(snippetPath));
    await writeFile(target, await readFile(snippetPath, 'utf8'), 'utf8');
    snippetFiles.push(target);
  }

  const scaffold = verifierScaffold(input.language, input.milvusVersion);
  const files = [pythonContextPath, ...snippetFiles];
  for (const file of scaffold.files) {
    const target = join(verifyDir, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, 'utf8');
    files.push(target);
  }

  return {
    files,
    command: scaffold.command
  };
}

function renderPythonContext(markdown: string): string {
  const blocks = Array.from(markdown.matchAll(/```python\n([\s\S]*?)```/gi)).map((match, index) => {
    return `## Python block ${index + 1}\n\n\`\`\`python\n${match[1]?.trim() ?? ''}\n\`\`\``;
  });
  return `${blocks.join('\n\n')}\n`;
}

function verifierScaffold(language: MultisdkLanguage, milvusVersion: string): {
  command: string;
  files: Array<{ path: string; content: string }>;
} {
  if (language === 'java') {
    return {
      command: 'mvn test',
      files: [
        {
          path: 'README.md',
          content: `# Java multi-SDK verifier\n\nMilvus target: ${milvusVersion}\n\nCopy reviewed Java snippets into the test and assert every SDK response succeeds.\n`
        },
        {
          path: 'pom.xml',
          content: javaVerifierPom()
        },
        {
          path: 'src/test/java/io/milvus/docs/MultisdkExamplesTest.java',
          content: javaVerifierTest()
        }
      ]
    };
  }
  if (language === 'javascript') {
    return {
      command: 'npm test',
      files: [
        { path: 'README.md', content: `# JavaScript multi-SDK verifier\n\nMilvus target: ${milvusVersion}\n` },
        { path: 'package.json', content: '{ "type": "module", "scripts": { "test": "node test.mjs" } }\n' },
        { path: 'test.mjs', content: 'console.log("replace with live Milvus assertions");\n' }
      ]
    };
  }
  if (language === 'go') {
    return {
      command: 'go test ./...',
      files: [
        { path: 'README.md', content: `# Go multi-SDK verifier\n\nMilvus target: ${milvusVersion}\n` },
        { path: 'go.mod', content: 'module multisdkverify\n\ngo 1.22\n' },
        { path: 'multisdk_examples_test.go', content: 'package multisdkverify\n\nimport "testing"\n\nfunc TestMultisdkExamples(t *testing.T) {}\n' }
      ]
    };
  }
  return {
    command: 'bash test-rest.sh',
    files: [
      { path: 'README.md', content: `# REST multi-SDK verifier\n\nMilvus target: ${milvusVersion}\n` },
      { path: 'test-rest.sh', content: '#!/usr/bin/env bash\nset -euo pipefail\n: "${MILVUS_ENDPOINT:?MILVUS_ENDPOINT is required}"\n' }
    ]
  };
}

function javaVerifierPom(): string {
  return `<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>

  <groupId>io.milvus.docs</groupId>
  <artifactId>multisdk-verify</artifactId>
  <version>1.0.0</version>

  <properties>
    <maven.compiler.source>11</maven.compiler.source>
    <maven.compiler.target>11</maven.compiler.target>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    <milvus.sdk.version>2.6.15</milvus.sdk.version>
    <junit.jupiter.version>5.10.2</junit.jupiter.version>
    <slf4j.version>1.7.36</slf4j.version>
  </properties>

  <dependencies>
    <dependency>
      <groupId>io.milvus</groupId>
      <artifactId>milvus-sdk-java</artifactId>
      <version>\${milvus.sdk.version}</version>
    </dependency>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>\${junit.jupiter.version}</version>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>org.slf4j</groupId>
      <artifactId>slf4j-simple</artifactId>
      <version>\${slf4j.version}</version>
      <scope>test</scope>
    </dependency>
  </dependencies>

  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <version>3.2.5</version>
      </plugin>
    </plugins>
  </build>
</project>
`;
}

function javaVerifierTest(): string {
  return `package io.milvus.docs;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.fail;

class MultisdkExamplesTest {
  private static final String URI = System.getenv().getOrDefault("MILVUS_URI", "http://localhost:19530");

  @Test
  void authoredExamplesMustRunAgainstLiveMilvus() {
    fail("Replace this scaffold with live Milvus assertions for the authored Java snippets. Target URI: " + URI);
  }
}
`;
}
