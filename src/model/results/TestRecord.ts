import cp = require('child_process');
import tmp = require('tmp');
import fs = require('fs');
import {IConfig, AppConfig} from '../../Config';

import {Commit} from '../GithubUtil';
import {CouchDatabase,Database, DatabaseRecord, InsertResponse} from '../Database';


export interface Deliverable {
  name: string;  // short name: d1-priv
  repo: string;  // full name: cpsc310d1-priv
  visibility: number;
  image: string;
}






interface TestOutput {
  mocha: JSON,
  testStats: TestStats
}

interface TestStats {
  passPercent: number;
  passCount: number;
  failCount: number;
  skipCount: number;
  passNames: string[];
  failNames: string[];
  skipNames: string[];
}

export interface CoverageStat {
  percentage: number;
  touched: number;
  total: number;
}
export interface CoverageStats {
  statements: CoverageStat;
  branches: CoverageStat;
  functions: CoverageStat;
  lines: CoverageStat;
}

export interface ProcessedTag {
  content: any;
  exitcode: number;
}


export interface ITestRecord {
  _id: string;
  _rev?: string;

  team: string;
  deliverable: Deliverable;


  stdio: string;
  coverageZip: Buffer;

}



export default class TestRecord implements DatabaseRecord {
  // private config: IConfig;

  private stdio: string;
  private coverageZip: Buffer;

  private githubToken: string;
  private _id: string;
  private _rev: string;
  private team: string;
  private deliverable: Deliverable;
  private testStats: TestStats;
  private coverageStats: CoverageStats;
  private buildFailed: boolean;
  private buildMsg: string;
  private testReport: any;
  private commit: string;
  private committer: string;
  private timestamp: number;

  constructor(githubToken: string, team: string, user: string, commit: Commit, deliverable: Deliverable) {
    //this.config = new AppConfig();
    this.githubToken = githubToken;
    this.team = team;
    this.deliverable = deliverable
    this.commit = commit.short;
    this.committer = user;
    this.timestamp = +new Date();
    this._id = this.timestamp + '_' + this.team + ':' + this.deliverable.name;
  }

  public async generate() {
    //let db: Database = new Database(this.config.getDBConnection(), 'results');
    let promises: Promise<boolean>[] = [];
    //let db = require('nano')("http://localhost:5984/results");
    let tempDir = tmp.dirSync();
    let file: string = './docker/tester/run-test-container.sh';
    let args: string[] = [
      this.githubToken,
      this.team,
      this.commit,
      this.deliverable.image,
      tempDir.name
    ];
    let options = {
      encoding: 'utf8'
    }

    await new Promise((fulfill, reject) => {
      cp.execFile(file, args, options, (error, stdout, stderr) => {
        if (error) reject(error);
        fulfill();
      });
    });

    let readTranscript: Promise<boolean> = new Promise((fulfill, reject) => {
      fs.readFile(tempDir.name + '/stdio.txt', 'utf8', (err, data) => {
        if (err) reject(err);
        try {
          this.stdio = data;

          // Process the project build tag
          let buildTag: ProcessedTag = this.processProjectBuildTag(data);
          this.buildFailed = (buildTag.exitcode > 0 ? true : false);
          this.buildMsg = buildTag.content;

          // Process the coverage tag
          let coverageTag: ProcessedTag = this.processCoverageTag(data);
          this.coverageStats = coverageTag.content;

          fulfill(true);
        } catch(err) {
          reject(err);
        }
      });
    });
    promises.push(readTranscript);

    let readTests: Promise<boolean> = new Promise((fulfill, reject) => {
      fs.readFile(tempDir.name + '/mocha.json', 'utf8', (err, data) => {
        if (err) reject(err);
        try {
          let tests: TestOutput = this.processMochaJson(data);
          this.testStats = tests.testStats;
          this.testReport = tests.mocha;
          fulfill();
        } catch(err) {
          reject(err);
        }
      });
    });
    promises.push(readTests);

    let readCoverage: Promise<boolean> = new Promise((fulfill, reject) => {
      fs.readFile(tempDir.name + '/coverage.zip', (err, data) => {
        if (err) reject(err);
        this.coverageZip = data;
        fulfill();
      });
    });
    promises.push(readCoverage);

    await Promise.all(promises);

    //return db.insert(record);
  }


  public processProjectBuildTag(stdout: string): ProcessedTag {
    try {
      let buildTagRegex: RegExp = /^<PROJECT_BUILD exitcode=(\d+)>((?!npm)[\s\S]*)<\/PROJECT_BUILD>$/gm
      let buildMsgRegex: RegExp = /^(npm.*)$/gm;
      let matches: string[] = buildTagRegex.exec(stdout);
      let processed: ProcessedTag = {
        content: matches[2].replace(buildMsgRegex, '').trim(),
        exitcode: +matches[1]
      };
      return processed;
    } catch (err) {
      throw 'Failed to process <PROJECT_BUILD> tag. ' + err;
    }
  }


  public processCoverageTag(stdout: string): ProcessedTag {
    try {
      let coverageTagRegex: RegExp = /^<PROJECT_COVERAGE exitcode=(\d+)>([\s\S]*)<\/PROJECT_COVERAGE>$/gm;
      let matches: string[] = coverageTagRegex.exec(stdout);
      let exitcode: number = +matches[1];
      let content: string = matches[2];
      let stats: CoverageStat[] = [];

      for (let stat of ['Statements', 'Branches', 'Functions', 'Lines']) {
        let regex: RegExp = new RegExp(stat+'\\s+: ([0-9\\.]+)% \\( (\\d+)\\/(\\d+) \\)','gm');
        let matches: string[] = regex.exec(content);

        let coverStat: CoverageStat = {
          percentage: +matches[1],
          touched: +matches[2],
          total: +matches[3]
        }
        stats.push(coverStat);
      }

      let processed: ProcessedTag = {
        content: {
          statements: stats[0],
          branches: stats[1],
          functions: stats[2],
          lines: stats[3]
        },
        exitcode: exitcode
      };

      return processed;
    } catch(err) {
      throw 'Failed to process <PROJECT_COVERAGE> tag. ' + err;
    }
  }



  public processMochaJson(text: string): TestOutput {
    try {
      let report: any = JSON.parse(text);
      let passPercent: number = report.stats.passPercent;
      let passCount: number = report.stats.passes;
      let failCount: number = report.stats.failures;
      let skipCount: number = report.stats.skipped;

      let passNames: string[] = report.allTests.filter(test => {
        return test.pass;
      }).map(name => {
        let fullName: string = name.fullTitle;
        return fullName.substring(fullName.indexOf('~')+1, fullName.lastIndexOf('~'));
      });
      let failNames: string[] = report.allTests.filter(test => {
        return test.fail;
      }).map(name => {
        let fullName: string = name.fullTitle;
        return fullName.substring(fullName.indexOf('~')+1, fullName.lastIndexOf('~'));
      });
      let skipNames: string[] = [].concat.apply([], report.suites.suites.filter(suite => {
        return suite.hasSkipped;
      }).map(suite => {
        return suite.skipped.map(skippedTest => {
          let fullName: string = skippedTest.fullTitle;
          return fullName.substring(fullName.indexOf('~')+1, fullName.lastIndexOf('~'));
        });
      }));

      let processed: TestOutput = {
        mocha: report,
        testStats: {
          passPercent: passPercent,
          passCount: passCount,
          failCount: failCount,
          skipCount: skipCount,
          passNames: passNames,
          failNames: failNames,
          skipNames: skipNames
        }
      }

      return processed;
    } catch(err) {
      throw 'Failed to process mocha test report (JSON). ' + err;
    }
  }


  public async create(db: CouchDatabase): Promise<InsertResponse> {
    return this.insert(db);
  }

  public async update(db: CouchDatabase): Promise<InsertResponse> {
    return new Promise<InsertResponse>((fulfill, reject) => {
      reject('Not allowed.');
    })
  }

  private async insert(db: CouchDatabase): Promise<InsertResponse> {

    let doc = {
      'team': this.team,
      'deliverable': this.deliverable,
      'testStats': this.testStats,
      'coverStats': this.coverageStats,
      'buildFailed': this.buildFailed,
      'buildMsg': this.buildMsg,
      'testReport': this.testReport,
      'commit': this.commit,
      'committer': this.committer,
      'timestamp': this.timestamp
    }

    let attachments = [
      {name: 'stdio.txt', data: this.stdio, content_type: 'application/plain'},
      {name: 'coverage.zip', data: this.coverageZip, content_type: 'application/zip'}
    ]


    let that = this;
    return new Promise<InsertResponse>((fulfill, reject) => {
      db.multipart.insert(doc, attachments, this._id, (err, body) => {
        if (err) reject(err);
        fulfill(body);
      });
    });
  }

  // public async insertWithAttachments(db: CouchDatabase): Promise<InsertResponse> {
  //   let doc = {
  //     'team': this.team,
  //     'deliverable': this.deliverable,
  //     'testStats': this.testStats,
  //     'coverStats': this.coverageStats,
  //     'buildFailed': this.buildFailed,
  //     'buildMsg': this.buildMsg,
  //     'testReport': this.testReport,
  //     'commit': this.commit,
  //     'committer': this.committer,
  //     'timestamp': this.timestamp
  //   }
  //
  //   let attachments = [
  //     {name: 'stdio.txt', data: this.stdio, content_type: 'application/plain'},
  //     {name: 'coverage.zip', data: this.coverageZip, content_type: 'application/zip'}
  //   ]
  //
  //
  //   let that = this;
  //   return new Promise<InsertResponse>((fulfill, reject) => {
  //     db.multipart.insert(doc, attachments, this._id, (err, body) => {
  //       if (err) reject(err);
  //       fulfill(body);
  //     });
  //   });
  // }

}