const core = require('@actions/core');
const shell = require('shelljs');
const fs = require('fs');
const { Octokit } = require("@octokit/rest");
const convert = require('xml-js');
let octokit;

async function main() {
    try {
        const orgName = core.getInput('gthub-org-name');
        const gthubUsername = core.getInput('gthub-username');
        const gthubToken = core.getInput('gthub-token');
        const dependencyRepoName = core.getInput('dependency-repo-name') || "dependency-details";

        octokit = new Octokit({ auth: gthubToken });

        const pomXmlTemplate = fs.readFileSync('./pomxml.template', 'utf8');
        const jsonFromPomXmlTemplate = await convert.xml2json(pomXmlTemplate, {compact: true, spaces: 4});
        let pomXmlTemplateJson = JSON.parse(jsonFromPomXmlTemplate);
        console.log(`pomXmlTemplateJson: ${JSON.stringify(pomXmlTemplateJson)}`);

        await shell.mkdir('-p', 'repos');
        await shell.cd('repos');

        let nodeDependencies = {
            dependencies: []
        };
        let nodeDependenciesWithRepoName = [];

        let mavenDependencies = {
            dependencies: []
        };
        let mavenDependenciesWithRepoName = [];

        for(let loopVar = 1; loopVar < 1000; loopVar++) {
            const response = await octokit.rest.repos.listForOrg("GET /orgs/{org}/repos", {
                org: orgName,
                type: "all",
                per_page: 100,
                page: loopVar
            });
            
            if(response.data.length == 0) {
                break;
            }

            for(let i = 0; i < response.data.length; i++) {
                const repo = response.data[i];
                const repoName = repo.name;
                const repoUrl = `https://${gthubUsername}:${gthubToken}@github.com/${repo.full_name}.git`;
                await shell.exec(`git clone ${repoUrl}`);
                
                if(fs.existsSync(`./${repoName}/package.json`)) {
                    const packageJson = JSON.parse(fs.readFileSync(`./${repoName}/package.json`, 'utf8'));
                    console.log(`package.json: ${JSON.stringify(packageJson)}`);
                    
                    const repoDependcies = getNodeRepoDependencies(packageJson);
                    nodeDependencies.dependencies = nodeDependencies.dependencies.concat(repoDependcies);
                    nodeDependenciesWithRepoName.push({
                        repoName: repoName,
                        dependencies: repoDependcies
                    });
                }

                if(fs.existsSync(`./${repoName}/pom.xml`)) {
                    const pomXml = fs.readFileSync(`./${repoName}/pom.xml`, 'utf8');
                    const jsonFromXml = await convert.xml2json(pomXml, {compact: true, spaces: 4});
                    console.log("jsonFromXml dependency: ", JSON.parse(jsonFromXml).project.dependencies);
                    
                    let repoDependcies = [];
                    if(JSON.parse(jsonFromXml).project.dependencies) {
                        repoDependcies = JSON.parse(jsonFromXml).project.dependencies.dependency;
                    } else if(JSON.parse(jsonFromXml).project.dependencyManagement) {
                        repoDependcies = JSON.parse(jsonFromXml).project.dependencyManagement.dependencies.dependency;
                    }
                    
                    mavenDependencies.dependencies = mavenDependencies.dependencies.concat(repoDependcies);
                    mavenDependenciesWithRepoName.push({
                        repoName: repoName,
                        dependencies: repoDependcies
                    });
                }
            }
        }
        await shell.cd('..');
        await shell.rm('-rf', 'repos');

        const dependencyRepoExists = await getDependencyRepoStatus(orgName, dependencyRepoName);
        console.log(`dependencyRepoExists: ${dependencyRepoExists}`);

        if(!dependencyRepoExists) {
            // create the repository
            const dependencyRepoCreResp = await octokit.rest.repos.createInOrg({
                name: dependencyRepoName,
                org: orgName,
                description: "This repository contains details for dependencies used in all the repositories in the organization.",
                private: true,
                auto_init: true
            });
            console.log(`dependencyRepoCreResp: ${JSON.stringify(dependencyRepoCreResp.data)}`);
        }
        shell.mkdir('-p', 'temp');
        shell.cd('temp');

        // get unique node dependencies
        const uniqueNodeDependencies = nodeDependencies.dependencies.filter((item, pos) => {
            return nodeDependencies.dependencies.indexOf(item) == pos;
        });
        console.log(`uniqueNodeDependencies: ${JSON.stringify(uniqueNodeDependencies)}`);

        // get unique maven dependencies
        const uniqueMavenDependencies = mavenDependencies.dependencies.filter((item, pos) => {
            return mavenDependencies.dependencies.indexOf(item) == pos;
        });
        console.log(`uniqueMavenDependencies: ${JSON.stringify(uniqueMavenDependencies)}`);

        pomXmlTemplateJson.project.dependencies = {};
        pomXmlTemplateJson.project.dependencies.dependency = uniqueMavenDependencies;

        let xmlOptions = {compact: true, ignoreComment: true, spaces: 4};
        var pomXmlData = await convert.json2xml(pomXmlTemplateJson, xmlOptions);

        const dependencyRepoURL = `https://${gthubUsername}:${gthubToken}@github.com/${orgName}/${dependencyRepoName}.git`
        await shell.exec(`git clone ${dependencyRepoURL}`);

        await shell.cd(dependencyRepoName);

        fs.writeFileSync(`./node_dependencies.json`, JSON.stringify(uniqueNodeDependencies, null, 2));
        fs.writeFileSync(`./node_dependencies_with_repo.json`, JSON.stringify(nodeDependenciesWithRepoName, null, 2));
        fs.writeFileSync(`./maven_dependencies.json`, JSON.stringify(uniqueMavenDependencies, null, 2));
        fs.writeFileSync(`./maven_dependencies_with_repo.json`, JSON.stringify(mavenDependenciesWithRepoName, null, 2));
        fs.writeFileSync('./pom.xml', pomXmlData);

        
        await shell.exec(`git config user.email "vishnuprabhakar7@gmail.com"`);
        await shell.exec(`git config user.name "Vishnu Prabhakar"`);
        await shell.exec(`git add .`);
        await shell.exec(`git commit -m "Updated dependency details"`);
        await shell.exec(`git push origin main`);

        console.log("Dependency details updated successfully");

        shell.cd('../..');
        await shell.rm('-rf', 'temp');
    } catch (error) {
        console.log(error);
    }
}

async function getDependencyRepoStatus(orgName, dependencyRepoName) {
    try {
        const response = await octokit.rest.repos.get({
            owner: orgName,
            repo: dependencyRepoName
        });
        console.log(`dependencyRepoStatus: ${JSON.stringify(response.data)}`);

        return true;
    } catch (error) {
        return false;
    }
}

function getNodeRepoDependencies(packageJson) {
    let dependencies = [];
    if(packageJson.dependencies) {
        for(let key in packageJson.dependencies) {
            dependencies.push({
                name: key,
                version: packageJson.dependencies[key]
            });
        }
    }

    if(packageJson.devDependencies) {
        for(let key in packageJson.devDependencies) {
            dependencies.push({
                name: key,
                version: packageJson.devDependencies[key]
            });
        }
    }
    
    return dependencies;
}

function getMavenRepoDependencies(dependencies) {
    let mavenDependencies = [];
    if(dependencies) {
        if(Array.isArray(dependencies)) {
            for(let i = 0; i < dependencies.length; i++) {
                const dependency = dependencies[i];
                if(dependency.version) {
                    mavenDependencies.push({
                        groupId: dependency.groupId._text,
                        artifactId: dependency.artifactId._text,
                        version: dependency.version._text
                    });
                } else {
                    mavenDependencies.push({
                        groupId: dependency.groupId._text,
                        artifactId: dependency.artifactId._text
                    });
                }
            }
        } else {
            if(dependencies.version) {
                mavenDependencies.push({
                    groupId: dependencies.groupId._text,
                    artifactId: dependencies.artifactId._text,
                    version: dependencies.version._text
                });
            } else {
                mavenDependencies.push({
                    groupId: dependencies.groupId._text,
                    artifactId: dependencies.artifactId._text
                });
            }
        }
    }
    return mavenDependencies;
}

main();
