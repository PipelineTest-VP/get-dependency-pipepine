const core = require('@actions/core');
const shell = require('shelljs');
const fs = require('fs');
const { Octokit } = require("@octokit/rest");

const xml2js = require('xml2js');

const parser = new xml2js.Parser({
    explicitArray: false
});
const builder = new xml2js.Builder();

let octokit;

async function main() {
    try {
        const orgName = core.getInput('gthub-org-name');
        const gthubUsername = core.getInput('gthub-username');
        const gthubToken = core.getInput('gthub-token');
        const gthubUser = core.getInput('gthub-user');
        const gthubUserEmail = core.getInput('gthub-user-email');
        const dependencyRepoName = core.getInput('dependency-repo-name') || "dependency-details";

        octokit = new Octokit({ auth: gthubToken });

        const pomXmlTemplate = fs.readFileSync('./pomxml.template', 'utf8');
        let pomXmlTemplateJson = await parser.parseStringPromise(pomXmlTemplate);

        await shell.mkdir('-p', 'repos');
        await shell.cd('repos');

        let nodeDependencies = {
            dependencies: []
        };
        let nodeDependenciesWithRepoName = [];

        let mavenDependencies = {
            dependencies: {
                dependency: []
            }
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
                
                if(repoName !== dependencyRepoName && fs.existsSync(`./${repoName}/package.json`)) {
                    const packageJson = JSON.parse(fs.readFileSync(`./${repoName}/package.json`, 'utf8'));
                    
                    const repoDependcies = getNodeRepoDependencies(packageJson);
                    nodeDependencies.dependencies = nodeDependencies.dependencies.concat(repoDependcies);
                    nodeDependenciesWithRepoName.push({
                        repoName: repoName,
                        dependencies: repoDependcies
                    });
                }

                if(repoName !== dependencyRepoName && fs.existsSync(`./${repoName}/pom.xml`)) {
                    const pomXml = fs.readFileSync(`./${repoName}/pom.xml`, 'utf8');
                    const jsonFromXml = await parser.parseStringPromise(pomXml);
                    console.log("jsonFromXml : ", jsonFromXml);
                    
                    let repoDependcies;
                    if(jsonFromXml.project.dependencies && jsonFromXml.project.dependencies.dependency) {
                        repoDependcies = jsonFromXml.project.dependencies.dependency;
                    } else if(jsonFromXml.project.dependencyManagement && jsonFromXml.project.dependencyManagement.dependencies && jsonFromXml.project.dependencyManagement.dependencies.dependency) {
                        repoDependcies = jsonFromXml.project.dependencyManagement.dependencies.dependency;
                    }
                    console.log("repoDependcies : ", repoDependcies);

                    if(Array.isArray(repoDependcies)) {
                        mavenDependencies.dependencies.dependency = mavenDependencies.dependencies.dependency.concat(repoDependcies);
                    } else {
                        if(repoDependcies) {
                            mavenDependencies.dependencies.dependency.push(repoDependcies);
                        }
                    }
                    
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

        if(!dependencyRepoExists) {
            // create the repository
            const dependencyRepoCreResp = await octokit.rest.repos.createInOrg({
                name: dependencyRepoName,
                org: orgName,
                description: "This repository contains details for dependencies used in all the repositories in the organization.",
                private: true,
                auto_init: true
            });
        }
        shell.mkdir('-p', 'temp');
        shell.cd('temp');

        // get unique node dependencies
        const uniqueNodeDependencies = nodeDependencies.dependencies.filter((item, pos) => {
            return nodeDependencies.dependencies.indexOf(item) == pos;
        });

        // get unique maven dependencies
        const uniqueMavenDependencies = mavenDependencies.dependencies.dependency.filter((item, pos) => {
            const _value = JSON.stringify(item);
            return pos === mavenDependencies.dependencies.dependency.findIndex(obj => {
                return JSON.stringify(obj) === _value;
            });
            //return mavenDependencies.dependencies.dependency.indexOf(item) == pos;
        });
        console.log(`uniqueMavenDependencies: ${JSON.stringify(uniqueMavenDependencies)}`);

        pomXmlTemplateJson.project.dependencies = {};
        pomXmlTemplateJson.project.dependencies.dependency = uniqueMavenDependencies;
        console.log(`pomXmlTemplateJson: ${JSON.stringify(pomXmlTemplateJson)}`);

        const pomXmlData = builder.buildObject(pomXmlTemplateJson);

        const dependencyRepoURL = `https://${gthubUsername}:${gthubToken}@github.com/${orgName}/${dependencyRepoName}.git`
        await shell.exec(`git clone ${dependencyRepoURL}`);

        await shell.cd(dependencyRepoName);

        fs.writeFileSync(`./node_dependencies.json`, JSON.stringify(uniqueNodeDependencies, null, 2));
        fs.writeFileSync(`./node_dependencies_with_repo.json`, JSON.stringify(nodeDependenciesWithRepoName, null, 2));
        fs.writeFileSync(`./maven_dependencies.json`, JSON.stringify(uniqueMavenDependencies, null, 2));
        fs.writeFileSync(`./maven_dependencies_with_repo.json`, JSON.stringify(mavenDependenciesWithRepoName, null, 2));
        fs.writeFileSync('./pom.xml', pomXmlData);

        
        await shell.exec(`git config user.email "${gthubUserEmail}"`);
        await shell.exec(`git config user.name "${gthubUser}"`);
        await shell.exec(`git add .`);
        await shell.exec(`git commit -m "Updated dependency details"`);
        await shell.exec(`git push origin main`);

        console.log("Dependency details updated successfully");

        shell.cd('../..');
        await shell.rm('-rf', 'temp');
    } catch (error) {
        console.log(error);
        core.setFailed(error.message);
    }
}

async function getDependencyRepoStatus(orgName, dependencyRepoName) {
    try {
        const response = await octokit.rest.repos.get({
            owner: orgName,
            repo: dependencyRepoName
        });

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

main();
