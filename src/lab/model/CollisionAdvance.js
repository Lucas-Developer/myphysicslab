// Copyright 2016 Erik Neumann.  All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the 'License');
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an 'AS IS' BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

goog.provide('myphysicslab.lab.model.CollisionAdvance');

goog.require('goog.array');
goog.require('goog.asserts');
goog.require('myphysicslab.lab.model.ODEAdvance');
goog.require('myphysicslab.lab.model.Collision');
goog.require('myphysicslab.lab.model.CollisionSim');
goog.require('myphysicslab.lab.model.CollisionStats');
goog.require('myphysicslab.lab.model.CollisionTotals');
goog.require('myphysicslab.lab.model.DiffEqSolver');
goog.require('myphysicslab.lab.model.RungeKutta');
goog.require('myphysicslab.lab.util.Util');

goog.scope(function() {

var Collision = myphysicslab.lab.model.Collision;
var CollisionSim = myphysicslab.lab.model.CollisionSim;
var CollisionStats = myphysicslab.lab.model.CollisionStats;
var CollisionTotals = myphysicslab.lab.model.CollisionTotals;
var DiffEqSolver = myphysicslab.lab.model.DiffEqSolver;
var NF = myphysicslab.lab.util.Util.NF;
var NF5 = myphysicslab.lab.util.Util.NF5;
var NF5E = myphysicslab.lab.util.Util.NF5E;
var NF7 = myphysicslab.lab.util.Util.NF7;
var NF7E = myphysicslab.lab.util.Util.NF7E;
var NFE = myphysicslab.lab.util.Util.NFE;
var NFSCI = myphysicslab.lab.util.Util.NFSCI;
var ODEAdvance = myphysicslab.lab.model.ODEAdvance;
var RungeKutta = myphysicslab.lab.model.RungeKutta;
var Util = myphysicslab.lab.util.Util;

/** Handles collisions by backing up in time with binary search algorithm. For better
performance uses collision time estimates and handles imminent collisions.

When a collision is encountered, {@link #advance} backs up to just before the time of
collision, handles the collision, then continues to advance to the end of the time step.
(This process can happen many times during a single call to `advance`). Uses a binary
search algorithm to get to the time just before the collision.
The {@link DiffEqSolver} is used to move the simulation forward in time.

## Debugging with WayPoints

CollisonAdvance can be very tricky to debug because the set of Collisions found drive
the process, yet they come and go as we move backward and forward in time. Specifying
WayPoints lets you focus on only the relevant aspects of the process, greatly reducing
the volume of debug messages to sort thru.

A {@link CollisionAdvance.WayPoint WayPoint} is a step of the AdvanceStrategy process
where debug info can be printed. See the methods {@link #addWayPoints},
{@link #setWayPoints}. The method {@link #setDebugLevel} selects a pre-defined group of
WayPoints.

See [Observing The Collision Handling Process](Engine2D.html#observingthecollisionhandlingprocess)
in 2D Physics Engine Overview, and {@link CollisionAdvance.DebugLevel}.

* @param {!CollisionSim} sim the CollisionSim to advance in time
* @param {!DiffEqSolver=} opt_diffEqSolver the DiffEqSolver to use, default is
*     RungeKutta
* @constructor
* @final
* @struct
* @implements {ODEAdvance}
*/
myphysicslab.lab.model.CollisionAdvance = function(sim, opt_diffEqSolver) {
  /**
  * @type {!CollisionSim}
  * @private
  */
  this.sim_ = sim;
  /**
  * @type {!DiffEqSolver}
  * @private
  */
  this.odeSolver_ = opt_diffEqSolver || new RungeKutta(sim);
  /** Default amount of time to advance the simulation, in seconds.
  * @type {number}
  * @private
  */
  this.timeStep_ = 0.025;
  /** Set of waypoints at which to print debug messages
  * @type {!Array<CollisionAdvance.WayPoint>}
  * @private
  */
  this.wayPoints_ = [CollisionAdvance.WayPoint.STUCK];
  /** Whether to apply small impacts to joints to keep them aligned.
  * @type {boolean}
  * @private
  */
  this.jointSmallImpacts_ = false;
  /** For debugging, when we last printed a debug message.
  * @type {number}
  * @private
  */
  this.printTime_ = Util.NEGATIVE_INFINITY;
  /** long term count of number of collisions, backups, ode steps taken, etc.
  * @type {!CollisionTotals}
  * @private
  */
  this.collisionTotals_ = new CollisionTotals();

  // =======================================================================
  // The following variables exist only for communicating between
  // the advance() method and its sub-methods.
  // There is no persistent state, these variables have no meaning unless
  // the advance() method is executing.
  // An alternative design is to use local variables and nested functions, but
  // that seems harder to read and results in a performance hit from the nested
  // functions, see:
  // http://code.tutsplus.com/tutorials/stop-nesting-functions-but-not-all-of-them--net-22315
  // http://stackoverflow.com/questions/8628866/javascript-arguments-vs-nested-functions-vs-performance
  // =======================================================================

  /** how much time currently trying to advance
  * @type {number}
  * @private
  */
  this.currentStep_ = 0;
  /** how much time simulation has advanced
  * @type {number}
  * @private
  */
  this.timeAdvanced_ = 0;
  /** total length of time requested to advance
  * @type {number}
  * @private
  */
  this.totalTimeStep_ = 0;
  /** the estimated time when the next collision will happen.
  * @type {number}
  * @private
  */
  this.nextEstimate_ = Util.NaN;
  /** the current set of collisions; includes joints, contacts, imminent collisions
  * @type {!Array<!Collision>}
  * @private
  */
  this.collisions_ = new Array();
  /** statistics about the current set of collisions
  * @type {!CollisionStats}
  * @private
  */
  this.stats_ = new CollisionStats();
  /** set of collisions that were 'not close enough' to be handled.  These are kept to
  * find the estimated time of next collision after handling current collisions.
  * @type {!Array<!Collision>}
  * @private
  */
  this.removedCollisions_ = new Array();
  /** whether searching for collision using binary search algorithm
  * @type {boolean}
  * @private
  */
  this.binarySearch_ = false;
  /** during binary search, number of consecutive same-size steps; should never exceed 2
  * @type {number}
  * @private
  */
  this.binarySteps_ = 0;
  /** during binary search, remembers time when earliest collision was detected
  * @type {number}
  * @private
  */
  this.detectedTime_ = NaN;
  /** for detecting 'stuck' condition
  * @type {number}
  * @private
  */
  this.stuckCount_ = 0;
  /* How to use debugPaint_:
  * Note that RigidBodySim has a debugPaint_, it is called inside moveObjects()
  * Note that CollisionAdvance has a debugPaint_; ensure it calls sim.setDebugPaint().
  * Ensure that advance.setDebugPaint is called at startup in SimRunner:
  *    advance.setDebugPaint(goog.bind(this.paintAll, this));
  * Ensure the moving object is drawn above walls (otherwise can't see overlap).
  * Ensure test does not start running when loaded:  do clock.pause() at start.
  * Ensure you are zoomed in enough to see the overlap of the objects.
  * Run the test from source code (easier to understand code while in debugger).
  * Click 'stop script execution' button in console (else can't set a breakpoint).
  * Set a break point in SimRunner.callback, but not in the 'idle loop'.
  * Hit step or play button in web page, to start the simulation.
  * Set a break point in RigidBodySim.moveObjects on the debugPaint_ call.
  * Hit console debugger's 'continue execution' button.
  * Each time you stop at moveObjects, the debugPaint_ shows new situation.
  */
  /** function to paint canvases, for debugging.  If defined, this will be called within
  * `do_advance_sim()`, so you can see the simulation state after each
  * collision is handled (you will need to arrange your debugger to pause after
  * each invocation of debugPaint_ to see the state).
  * @type {?function():undefined}
  * @private
  */
  this.debugPaint_ = null;
  /** how many ODE (ordinary diff eq) steps were taken
  * @type {number}
  * @private
  */
  this.odeSteps_ = 0;
  /** how many times we had to backup
  * @type {number}
  * @private
  */
  this.backupCount_ = 0;
  /**
  * @type {number}
  * @private
  */
  this.numClose_ = 0;
  /** how many collisions occurred
  * @type {number}
  * @private
  */
  this.collisionCounter_ = 0;
};
var CollisionAdvance = myphysicslab.lab.model.CollisionAdvance;

if (!Util.ADVANCED) {
  CollisionAdvance.prototype.toString = function() {
    return this.toStringShort().slice(0, -1)
        +', odeSolver_: '+this.odeSolver_.toStringShort()
        +', jointSmallImpacts_: '+this.jointSmallImpacts_
        +'}';
  };

  /** @inheritDoc */
  CollisionAdvance.prototype.toStringShort = function() {
    return 'CollisionAdvance{sim_: '+this.sim_.toStringShort()+'}';
  };
}

/** The maximum number of times to go thru the loop in `advance()` without a successful
step that advances the simulation time; when this limit is exceeded then `advance()`
returns `false` to indicate it was unable to advance the simulation.
* @type {number}
* @const
* @private
*/
CollisionAdvance.MAX_STUCK_COUNT = 30;

/** Enum that specifies pre-defined groups of debug messages to show.
* @readonly
* @enum {number}
*/
CollisionAdvance.DebugLevel = {
  /** no debug messages */
  NONE: 0,
  /** low debug level: shows brief summary of number of collisions handled */
  LOW: 1,
  /** medium debug level: shows all collisions that are handled */
  MEDIUM: 2,
  /** optimal debug level: best for understanding how collisions are handled */
  OPTIMAL: 3,
  /** high debug level: shows full set of debug messages */
  HIGH: 4,
  /** custom debug level: shows a customized set of debug messages */
  CUSTOM: 5
};

/** Enum that specifies debugging 'way points' for {@link CollisionAdvance}. A WayPoint
is a step of the AdvanceStrategy process where debug info can be printed.
* @readonly
* @enum {number}
*/
CollisionAdvance.WayPoint = {
  /** at start of advance method */
  START: 0,
  /** when advanced without backup */
  ADVANCED_NO_BACKUP: 1,
  /** at finish of advance method */
  FINISH: 2,
  /** when starting to advance the simulation a step */
  ADVANCE_SIM_START: 3,
  /** when trying to advance the simulation a step fails */
  ADVANCE_SIM_FAIL: 4,
  /** when advancing the simulation advances a step, but there are collisions */
  ADVANCE_SIM_COLLIDING: 5,
  /** when finished advancing the simulation a step */
  ADVANCE_SIM_FINISH: 6,
  /** when starting to backup after a collision detected. */
  POST_COLLISION: 7,
  /** when finished backup after a collision detected. */
  PRE_COLLISION: 8,
  /** when starting to handle collisions. */
  HANDLE_COLLISION_START: 9,
  /** when removing distant-in-time collisions */
  HANDLE_REMOVE_DISTANT: 10,
  /** when successfully handled collisions. */
  HANDLE_COLLISION_SUCCESS: 11,
  /** when unable to handle collisions. */
  HANDLE_COLLISION_FAIL: 12,
  /** when starting to handle small impacts */
  SMALL_IMPACTS_START: 13,
  /** when finished handling small impacts */
  SMALL_IMPACTS_FINISH: 14,
  /** when failed to find collision during binary search */
  BINARY_SEARCH_FAIL: 15,
  /** when estimating time of next step */
  NEXT_STEP_ESTIMATE: 16,
  /** when calculating next step during binary search. */
  NEXT_STEP_BINARY: 17,
  /** when stuck, unable to advance. */
  STUCK: 18,
  /** at finish, show summary of collisions handled */
  SUMMARY: 19,
  /** when handling collisions, show list of collisions to handle */
  COLLISIONS_TO_HANDLE: 20,
  /** small impacts summary */
  SMALL_IMPACTS: 21,
  /** when no estimate or binary search, then take full step */
  NEXT_STEP_FULL: 22,
  /** when estimate of collision time is in the past, switch to binary search */
  ESTIMATE_IN_PAST: 23,
  /** when there are collisions that need handling, but no estimate of collision time,
  * switch to binary search */
  NO_ESTIMATE: 24,
  /** We had an estimate for collision time, but didn't find a collision */
  ESTIMATE_FAILED: 25,
  /** When we back up many times in a row without advancing, we may be stuck. */
  MAYBE_STUCK: 26
};
var WayPoint = CollisionAdvance.WayPoint;

/** Adds a group of WayPoints to show debug messages to the existing set of WayPoints.
* @param {!Array<!CollisionAdvance.WayPoint>} wayPoints  array
* of WayPoints to add
*/
CollisionAdvance.prototype.addWayPoints = function(wayPoints) {
  this.wayPoints_ = goog.array.concat(this.wayPoints_, wayPoints);
};

/** @inheritDoc */
CollisionAdvance.prototype.advance = function(timeStep, opt_memoList) {
  if (timeStep < 1E-16) {
    this.sim_.modifyObjects();
    return true;
  }
  if (0 == 1 && Util.DEBUG) {
    // turn on debug at a specific time
    var t = this.sim_.getTime();
    if (t >= 6.5 && t < 8.0) {
      this.setDebugLevel(CollisionAdvance.DebugLevel.HIGH);
    } else {
      this.setDebugLevel(CollisionAdvance.DebugLevel.NONE);
    }
  }
  // Remove all temporary elements that will expire during this step.
  // This helps with debugging because you can step thru the simulation and
  // see only the collisions that happen during this step.
  // When debugging, set the duration of temporary elements smaller
  // see RigidBodySim.debugCircle.
  this.sim_.getSimList().removeTemporary(this.sim_.getTime() + timeStep);
  this.timeAdvanced_ = 0;
  this.totalTimeStep_ = timeStep;
  this.currentStep_ = timeStep;
  this.binarySteps_ = 0;
  this.binarySearch_ = false;
  this.detectedTime_ = Util.NaN;
  this.nextEstimate_ = Util.NaN;
  this.stuckCount_ = 0;
  this.backupCount_ = 0;
  this.odeSteps_ = 0;
  this.collisionCounter_ = 0;
  this.numClose_ = 0;
  this.stats_.clear();
  this.collisions_ = [];
  this.sim_.getVarsList().saveHistory();
  this.print(WayPoint.START);
  var didHandle = false;
  // It may seem strange that we step forward, backup, and then handle collision.
  // Why not just handle the collision before step forward, and avoid the backup?
  // The reason is we usually don't know about the collision until we step forward,
  // because we mostly find collisions that are penetrating.  The exception is
  // imminent collisions which we can handle without needing to step and backup.
  //
  // Due to floating point math errors, can sometimes get tiny stepSize of 1.7E-18
  // from the calculation of stepSize = totalTimeStep - timeAdvanced.
  // It is possible to have x + (y - x) < y with floating point math.
  // See UtilEngine_test.testNumericalBug1().
  // ===================== until entire time step done =====================
  while (this.timeAdvanced_ < this.totalTimeStep_ - 1E-16) {
    var didAdvance = this.do_advance_sim(this.currentStep_);
    this.stats_.update(this.collisions_);
    // did not advance implies there are collisions
    goog.asserts.assert(didAdvance || this.stats_.numNeedsHandling > 0);
    this.print(WayPoint.ADVANCE_SIM_FINISH);
    // If there are any colliding collisions, then must backup.
    var didBackup = false;
    if (this.stats_.numNeedsHandling > 0) {
      this.detectedTime_ = this.stats_.detectedTime;
      this.do_backup(this.currentStep_);
      didBackup = true;
      // the colliding should now be marked 'mustHandle'
      this.stats_.update(this.collisions_);
      this.print(WayPoint.PRE_COLLISION);
      // When we back up many times in a row without advancing, we may be stuck.
      // RungeKutta solver does 4 evaluate() steps at 3 different times, so we
      // provide several chances to make progress before deciding that we are stuck.
      // Each evaluate() step can find a different set of collisions, but time
      // doesn't advance till all evaluate() steps all are completed.
      this.stuckCount_++;
      // NOTE: could increase this stuckCount limit to 4 to avoid binary search
      if (this.stuckCount_ >= 3) {
        if (!this.binarySearch_) {
          this.print(WayPoint.MAYBE_STUCK);
          this.binarySearch_ = true;
        }
        if (this.stuckCount_ >= CollisionAdvance.MAX_STUCK_COUNT) {
          this.print(WayPoint.STUCK);
          throw new Error('collision was not resolved after '+this.stuckCount_
            +' tries');
        }
      }
    }
    // If we did backup, then we cannot backup again to an earlier time; therefore
    // if any 'too tiny' collisions cannot be made to have a larger gap (closer
    // to the target gap size) we tell closeEnough to 'allowTiny'.
    // OTOH, if we did not backup, then we _could_ backup to an earlier time and
    // try to get a 'too tiny' collision to have a gap with size targetGap;
    // therefore 'allowTiny' is false.
    //
    // Find the number of collisions that are close enough (in distance) to the point
    // of collision to be able to handle the collision (apply an impulse).
    this.numClose_ = goog.array.count(this.collisions_, function(c) {
      return (c.needsHandling() || !c.contact())
        && c.getVelocity() < 0 && c.closeEnough(/*allowTiny=*/didBackup);
    });
    if (this.numClose_ > 0) {
      this.removedCollisions_ = [];
      if (this.removeDistant(didBackup)) {
        this.print(WayPoint.HANDLE_REMOVE_DISTANT);
      }
      var b = this.do_handle_collision(this.numClose_);
      didHandle = didHandle || b;
      this.nextEstimate_ = NaN;
      // stats_ are used by calc_next_step; base stats on removedCollisions
      this.stats_.update(this.removedCollisions_);
    }
    if (!didBackup) {
      // A ball bouncing on the floor leads to infinite series of smaller time steps
      // so require time step to be reasonable size to say we are not stuck.
      if (this.currentStep_ > 0.0000001) {
        this.stuckCount_ = 0;  // if we advanced, we are not stuck!
      }
      // We advanced and did not backup, therefore: update the time,
      // and memorize new data on the memoList.
      this.timeAdvanced_ += this.currentStep_;
      this.print(WayPoint.ADVANCED_NO_BACKUP);
      if (opt_memoList !== undefined) {
        opt_memoList.memorize();
      }
      if (this.binarySearch_ && ++this.binarySteps_ >= 2) {
        this.print(WayPoint.BINARY_SEARCH_FAIL);
        // Taking 2 or more binary search steps without backup indicates that we've
        // failed to find the collision (it disappeared), so stop the search.
        // We will then try to take a full step again, see calc_next_step()
        this.binarySearch_ = false;
        this.binarySteps_ = 0;
        this.detectedTime_ = NaN;
      } else if (isFinite(this.nextEstimate_)) {
        // The estimate failed, turn on binary search.
        // We had an estimate for collision time, but didn't find a collision.
        this.binarySearch_ = true;
        this.print(WayPoint.ESTIMATE_FAILED);
      }
    }
    // either we did a backup, or we handled some imminents; should be none colliding
    this.checkNoneCollide();
    this.calc_next_step(didBackup);
  } // end while loop
  if (!didHandle && this.jointSmallImpacts_ && this.stats_.numJoints > 0) {
    this.do_small_impacts();
  }
  //this.printJointDistance();
  this.collisionTotals_.addCollisions(this.collisionCounter_);
  this.collisionTotals_.addSteps(this.odeSteps_);
  this.collisionTotals_.addBackups(this.backupCount_);
  this.print(WayPoint.SUMMARY);
  this.print(WayPoint.FINISH);
};

/** Returns the velocities of the collisions.
* @param {!Array<!Collision>} collisions
* @return {!Array<number>} minimum velocities
* @private
*/
CollisionAdvance.prototype.allVelocities = function(collisions) {
  return goog.array.map(collisions, function(c, index, array) {
    return c.getVelocity();
  });
};

/** Determine size of next time step.
* @param {boolean} didBackup
* @private
*/
CollisionAdvance.prototype.calc_next_step = function(didBackup) {
  // assumes that stats are up-to-date
  this.nextEstimate_ = this.stats_.estTime;
  if (!this.binarySearch_) {
    // If estimate is in the past, switch to binary search
    if (this.nextEstimate_ < this.sim_.getTime()) {
      this.binarySearch_ = true;
      this.print(WayPoint.ESTIMATE_IN_PAST);
    }
    // If there are collisions that need handling, but no estimate, do binary search
    if (this.stats_.numNeedsHandling > 0 && isNaN(this.nextEstimate_)) {
      this.binarySearch_ = true;
      this.print(WayPoint.NO_ESTIMATE);
    }
  }
  var fullStep = this.totalTimeStep_ - this.timeAdvanced_;
  if (this.binarySearch_) {
    this.nextEstimate_ = NaN;
    // Note that stuckCount can increase during binary search whenever we backup
    // several times in a row; but the timestep is halved each time, so a limit
    // of around 30 for MAX_STUCK_COUNT should be OK, because:
    //    0.025 * 0.5^30 = 0.025 * 9.3E-10 = 2.3E-11
    // is a very tiny timestep, and we are likely stuck in that case anyway.
    if (didBackup) {
      // did not find collision, so reduce step size
      this.currentStep_ = this.currentStep_/2;
      // reset binary steps counter to allow at least 2 steps of this size.
      this.binarySteps_ = 0;
    }
    this.currentStep_ = Math.min(this.currentStep_, fullStep);
    this.print(WayPoint.NEXT_STEP_BINARY);
  } else if (!isNaN(this.nextEstimate_)) {
    // We have an estimate for next collision time -- from 2 scenarios:
    // 1) we backed up from a collision, found earliest estimate
    // 2) we removed a collision while handling collisions and remembered its estimate
    var nextStep = this.nextEstimate_ - this.sim_.getTime();
    goog.asserts.assert( nextStep >= 0 );
    this.currentStep_ = Math.min(nextStep, fullStep);
    this.print(WayPoint.NEXT_STEP_ESTIMATE);
  } else {
    // no binary search, and no estimate for next collision
    this.currentStep_ = fullStep; // try to step forward all the way
    this.print(WayPoint.NEXT_STEP_FULL);
  }
};

/** Check that there are no unhandled collisions at end of loop. At end of loop there
are two cases:

1. we did a backup to before the collision at which time there should be no unhandled
collisions

2. we handled the collisions

@return {undefined}
@private
*/
CollisionAdvance.prototype.checkNoneCollide = function() {
  if (Util.DEBUG) {
    var numIllegal = 0;
    goog.array.forEach(this.collisions_, function(c) {
      if (c.illegalState())
        numIllegal++;
    }, this);
    if (numIllegal > 0) {
      if (this.debugPaint_ != null) {
        this.debugPaint_();
      }
      this.myPrint('TROUBLE: found '+numIllegal+' colliding at end of loop');
      this.myPrint('stats '+this.stats_);
      this.printCollisions('TROUBLE', true);
      console.log(this.sim_.getVarsList().printHistory());
      throw new Error('checkNoneCollide numIllegal='+numIllegal);
    }
  }
};

/**
* @param {number} stepSize
* @return {boolean}
* @private
*/
CollisionAdvance.prototype.do_advance_sim = function(stepSize) {
  goog.asserts.assert(!isNaN(stepSize) && isFinite(stepSize));
  this.collisions_ = [];
  // ===================== save current state =====================
  this.sim_.saveState();
  if (Util.DEBUG && stepSize <= 1E-15) {
    this.myPrint('*** WARNING tiny time step = '+NFE(stepSize));
  }
  this.print(WayPoint.ADVANCE_SIM_START);
  // ===================== step the ODE forward =====================
  var error = this.odeSolver_.step(stepSize);
  this.sim_.modifyObjects();
  if (Util.DEBUG && this.debugPaint_ != null) {
    this.debugPaint_();
  }
  this.odeSteps_++;
  if (error != null) {
    // sim_.getTime() has NOT advanced; vars have NOT been changed.
    // ===================== collisions from ODE =====================
    this.collisions_ = /** @type {!Array<!Collision>} */(error);
    // Note that these collisions are found during a sub-step of the odeSolver.
    // Those sub-steps are not 'official' simulation states, they are instead
    // partial steps that are summed to produce a full step.
    // Therefore, the validity of these collisions is somewhat questionable.
    // However, we do Collision.updateCollision() later on to improve the accuracy.
    this.print(WayPoint.ADVANCE_SIM_FAIL);
  } else {
    // sim_.getTime() is now timeAdvanced + stepSize; vars have been updated
    // ===================== find collisions =====================
    var vars = this.sim_.getVarsList().getValues();
    this.sim_.findCollisions(this.collisions_, vars, stepSize);
    // For ImpulseSim, it is rare to find a collision here because
    // the collision checking is done inside evaluate().
    // However, because RungeKutta sums 4 estimates, it is (rarely) possible to
    // have a collision in the summed state even though there was no collision
    // during the 4 estimates.
    // For other CollisionSim's this is the only place to find collisions.
    this.print(WayPoint.ADVANCE_SIM_COLLIDING);
  }
  // Sort collisions by estimated collision time, earliest first.
  // We sort purely for convenience in debugging:  showing the collisions
  // in order of estimated collision time is much easier for a human to
  // look at the results.
  // When collisions get handled, the sort order doesn't matter (except for tests)
  // because we handle them in random order (the random order is repeatable
  // if we know the seed for the random number generator RNG).
  // The sort order DOES matter for tests; also the RNG matters. The order of
  // handling collisions strongly affects the outcome.
  // Because browsers have tiny differences in how they do floating point math,
  // we fuzz the sort comparison to 7 decimal places and use a stable sort.
  // This gives better test compatibility/repeatability across browsers, which can
  // have tiny differences in calculation of estimated collision time.
  // (Note: could still have rare cases where tiny differences round to different
  // numbers)
  goog.array.stableSort(this.collisions_,
    function(c1, c2) {
    // Round to 7 decimal places, to suppress differences between browsers.
    var est1 = Math.round(1E7 * c1.getEstimatedTime());
    var est2 = Math.round(1E7 * c2.getEstimatedTime());
    // Sort NaN at back, but if both are NaN then report equality.
    if (isNaN(est1))
      return isNaN(est2) ? 0 : 1;
    else if (isNaN(est2))
      return -1;
    else if (est1 < est2)
      return -1;
    else if (est1 > est2)
      return 1;
    else
      return 0;
    });
  goog.array.forEach(this.collisions_, function(c) {
    c.setNeedsHandling(c.isColliding());
  });
  return error == null;
};

/** Back-up in time to state before last step. Because collision is an illegal state and
we want to handle collisions at the moment just before collision so that objects are
always in a legal state.
* @param {number} stepSize
* @return {undefined}
* @private
*/
CollisionAdvance.prototype.do_backup = function(stepSize) {
  this.print(WayPoint.POST_COLLISION);
  this.sim_.restoreState();
  this.sim_.modifyObjects();
  if (Util.DEBUG && this.debugPaint_ != null) {
    this.debugPaint_();
  }
  this.backupCount_++;
  // Update collisions to reflect that the state changed back to earlier time.
  // The collisions will then report different results from methods like
  // isColliding() or getDistance();
  // However the needsHandling() status should be unchanged -- it remembers
  // which collisions caused the backup to occur.
  var time = this.sim_.getTime();
  for (var i=this.collisions_.length-1; i>=0; i--) {
    var c = this.collisions_[i];
    // We only retain *penetrating* collisions from the future set of collisions.
    // Those penetrating collisions were found by advancing to future time when
    // they are penetrating.
    // Other contacts (resting contacts and separating contacts) can be
    // found statically in findCollisions() according to current conditions.
    // The retained collisions can be replaced in findCollisions() as appropriate.
    if (!c.isColliding()) {
      goog.array.removeAt(this.collisions_, i);
      continue;
    }
    c.updateCollision(time);
  }
  // Note that this call to findCollisions() only uses the current static state;
  // CollisionSim.restoreState() erases any 'old body' previous state info.
  // There is no consideration of a body moving from on position to another.
  // Therefore this will only find collisions that are within the distance tolerance,
  // which will usually be resting contacts, but could be separating contacts,
  // and also imminent colliding contacts that are within distance tolerance.
  var vars = this.sim_.getVarsList().getValues();
  this.sim_.findCollisions(this.collisions_, vars, stepSize);
};

/**
* @param {number} numClose
* @return {boolean}
* @private
*/
CollisionAdvance.prototype.do_handle_collision = function(numClose) {
  this.print(WayPoint.HANDLE_COLLISION_START);
  this.print(WayPoint.COLLISIONS_TO_HANDLE);
  if (this.sim_.handleCollisions(this.collisions_, this.collisionTotals_)) {
    this.sim_.modifyObjects(); // updates velocities stored in RigidBody
    var time = this.sim_.getTime();
    goog.array.forEach(this.collisions_, function(c) {
      // Update the collisions to see new velocity (gets velocity from RigidBody)
      // (for debugging).
      c.updateCollision(time);
    });
    this.print(WayPoint.HANDLE_COLLISION_SUCCESS);
    // count number of binary searches completed
    if (this.binarySearch_) {
      this.collisionTotals_.addSearches(1);
    }
    this.collisionCounter_ += numClose;
    // Turn off the binarySearch flag after handling a collision, so that
    // we can use estimate from removed collisions (if any) for next step.
    // Otherwise we will just take a full step after this.
    this.binarySearch_ = false;
    this.binarySteps_ = 0;
    this.detectedTime_ = NaN;
    return true;
  } else {
    // Yikes!  handleCollisions was unable to do anything!  What now?
    // These situations seem to be when there was positive velocity
    // in the pre-collision state, so no impulse can be calculated.
    // Theory is that by getting closer to moment of collision, we will
    // see negative velocity and so be able to generate an impulse.
    this.binarySearch_ = true;
    this.print(WayPoint.HANDLE_COLLISION_FAIL);
    return false;
  }
};

/** Reduces velocity at joints to zero by doing `handleCollisions()`.
* @return {undefined}
* @private
*/
CollisionAdvance.prototype.do_small_impacts = function() {
  // EXPERIMENT OCT 2011:  Disable this entirely, because we are now
  // dealing with negative velocity at contacts by increasing acceleration.
  // See ContactSim.calculate_b_vector.
  // EXPERIMENT OCT 2011: do this only for Joints
  // Joints are now handled specially in that they get a small impulse at
  // each time step (because they don’t get the new extra acceleration fix that
  // non-joint contacts are getting instead of the small impulses,
  // see ContactSim.calculate_b_vector).
  // NOV 30 2011:  this must be done for all contacts, not just joints
  // otherwise you can have multiple collision ignoring contacts.
  // And, it must be done to keep joints aligned.
  // (You could perhaps skip this step if there are no joints)
  // JAN 5 2012:  It is possible to turn this off and instead enable
  // the 'extra acceleration to eliminate velocity' code for joints
  // in ContactSim.calculate_b_vector.  Results are almost as good.
  // FEB 2 2012: * try to move the “fix up joints” code to the end of the
  //CollisionAdvance.advance method. It only needs to be done once
  //during the entire step; not between every tiny partial step during collision
  //handling.
  // MAR 6 2012:  This 'small joint impacts' is being phased out gradually.
  // For now we leave it as an option so that the TestSuite can run as is.
  // Apply small impact for small velocity corrections at joints.
  if (this.collisions_.length > 0) {
    this.print(WayPoint.SMALL_IMPACTS_START);
    // ===================== fix up joints =====================
    this.removeDistant(false);
    // don't care if handleCollisions fails
    this.sim_.handleCollisions(this.collisions_, this.collisionTotals_);
    // NOTE: not adding these small impacts to the collision totals.
    this.sim_.modifyObjects();
    if (Util.DEBUG) {
      var time = this.sim_.getTime();
      goog.array.forEach(this.collisions_, function(c) {
        // update the collisions to see new velocity when debugging
        c.updateCollision(time);
      });
    }
    this.print(WayPoint.SMALL_IMPACTS_FINISH);
    this.print(WayPoint.SMALL_IMPACTS);
  }
};

/** Returns the CollisionTotals object giving collision statistics.
@return {!CollisionTotals} the CollisionTotals object giving
    collision statistics.
*/
CollisionAdvance.prototype.getCollisionTotals = function() {
  return this.collisionTotals_;
};

/** @inheritDoc */
CollisionAdvance.prototype.getDiffEqSolver = function() {
  return this.odeSolver_;
};

/** Whether to apply small impacts to joints to keep them aligned.
* @return {boolean} `true` means apply small impacts to joints
*/
CollisionAdvance.prototype.getJointSmallImpacts = function() {
  return this.jointSmallImpacts_;
};

/** @inheritDoc */
CollisionAdvance.prototype.getTime = function() {
  return this.sim_.getTime();
};

/** @inheritDoc */
CollisionAdvance.prototype.getTimeStep = function() {
  return this.timeStep_;
};

/** Returns the group of WayPoints to show debug messages at.
* @return {!Array<!CollisionAdvance.WayPoint>} the group of
*     WayPoints to show debug messages at.
*/
CollisionAdvance.prototype.getWayPoints = function() {
  return goog.array.clone(this.wayPoints_);
};

/** Returns the joint flags of collisions
* @param {!Array<!Collision>} collisions
* @return {!Array<boolean>} joint flags
* @private
*/
CollisionAdvance.prototype.jointFlags = function(collisions) {
  return goog.array.map(collisions, function(c, index, array) {
    return c.bilateral();
  });
};

/** Returns the maximum impulse applied to any of the collisions.
* @param {!Array<!Collision>} collisions
* @return {number} maximum impulse applied
* @private
*/
CollisionAdvance.prototype.maxImpulse = function(collisions) {
  return goog.array.reduce(collisions, function(max, c, index, array) {
    var impulse = c.getImpulse();
    return isFinite(impulse) ? Math.max(max, impulse) : max;
  }, 0);
};

/** Returns the smallest (most negative) velocity of the collisions.
* @param {!Array<!Collision>} collisions
* @return {number} minimum velocity
* @private
*/
CollisionAdvance.prototype.minVelocity = function(collisions) {
  return goog.array.reduce(collisions, function(min, c, index, array) {
    var v = c.getVelocity();
    return isFinite(v) ? Math.min(min, v) : min;
  }, Util.POSITIVE_INFINITY);
};

/**
* @param {string} message
* @param {...string} colors CSS color or background strings
* @private
*/
CollisionAdvance.prototype.myPrint = function(message, colors) {
  if (!Util.DEBUG)
    return;
  // Note that `colors` is never referenced within this function body.
  // It primarily exists so it can be annotated with `...` for the Compiler,
  // we get the CSS strings from `arguments`.
  var args = goog.array.slice(arguments, 1);
  args.unshift('%c'+NF7(this.sim_.getTime())+'%c '+message, 'color:blue', 'color:black');
  console.log.apply(console, args);
};

/** Print the debug message corresponding to the given WayPoint.
@param {CollisionAdvance.WayPoint} wayPoint the way point to
    print debug information for
@private
*/
CollisionAdvance.prototype.print = function(wayPoint) {
  if (!Util.DEBUG) {
    return;
  }
  if (!goog.array.contains(this.wayPoints_, wayPoint)) {
    return;
  }
  var s;
  var ccount;
  switch (wayPoint) {

    case WayPoint.START:
      this.myPrint('======== START advance;  timeStep='+this.totalTimeStep_);
      break;

    case WayPoint.ADVANCE_SIM_START:
      this.myPrint('ADVANCE_SIM_START: step(' + NF7(this.currentStep_)+') to '
          + NF7(this.sim_.getTime() + this.currentStep_)
          +' binarySearch='+this.binarySearch_
          +' nextEstimate='+NF7(this.nextEstimate_)
          +' stuckCount='+this.stuckCount_
          );
      break;

    case WayPoint.ADVANCE_SIM_FAIL:
      ccount = goog.array.count(this.collisions_, function(c) {
          return c.isColliding();
        });
      this.myPrint('ADVANCE_SIM_FAIL couldnt advance to '
          +NF7(this.sim_.getTime() + this.currentStep_)
          +' odeSolver.step found '+ccount+' colliding'
          +' among '+this.collisions_.length+' collisions'
          );
      break;

    case WayPoint.ADVANCE_SIM_COLLIDING:
      ccount = goog.array.count(this.collisions_, function(c) {
          return c.isColliding();
        });
      if (ccount > 0) {
        this.myPrint('ADVANCE_SIM_COLLIDING advanced by '+NF7(this.currentStep_)
            +' but found '+ccount+' colliding'
            +' binarySearch='+this.binarySearch_);
      }
      break;

    case WayPoint.ADVANCE_SIM_FINISH:
      this.myPrint('ADVANCE_SIM_FINISH '+this.stats_
          +' binarySearch='+this.binarySearch_
          );
      break;

    case WayPoint.POST_COLLISION:
      this.printCollisions('POST_COLLISION', false);
      this.myPrint('POST_COLLISION '+this.stats_);
      break;

    case WayPoint.PRE_COLLISION:
      this.printCollisions('PRE_COLLISION', false);
      this.myPrint('PRE_COLLISION '+this.stats_);
      break;

    case WayPoint.HANDLE_COLLISION_START:
      this.myPrint('HANDLE_COLLISION_START:'
          +' numClose='+this.numClose_
          );
      break;

    case WayPoint.COLLISIONS_TO_HANDLE:
      this.printCollisions('COLLISIONS_TO_HANDLE', false);
      break;

    case WayPoint.HANDLE_REMOVE_DISTANT:
      goog.array.forEach(this.removedCollisions_, function(c) {
          CollisionAdvance.printCollision(this.sim_.getTime(),
            'HANDLE_REMOVE_DISTANT:', c);
        }, this);
      break;

    case WayPoint.HANDLE_COLLISION_SUCCESS:
      this.myPrint('HANDLE_COLLISION_SUCCESS'
          +' max impulse='+NF5E(this.maxImpulse(this.collisions_))
          +' min velocity='+NF7E(this.minVelocity(this.collisions_)));
      this.printCollisions2('HANDLE_COLLISION_SUCCESS', 1E-3);
      break;

    case WayPoint.HANDLE_COLLISION_FAIL:
      this.myPrint('%cHANDLE_COLLISION_FAIL%c '
          +' detectedTime_='+NF7(this.detectedTime_)
          +' stuckCount='+this.stuckCount_
          ,'background:#f9c', 'color:black');
      this.printCollisions('HANDLE_COLLISION_FAIL', true);
      break;

    case WayPoint.ADVANCED_NO_BACKUP:
      this.myPrint('ADVANCED_NO_BACKUP'
          +' nextEstimate='+NF7(this.nextEstimate_)
          +' currentStep='+NF7E(this.currentStep_)
          +' imminent='+this.stats_.numImminent
          +' non-collisions='+(this.collisions_.length - this.stats_.numImminent));
      break;

    case WayPoint.SMALL_IMPACTS_START:
      this.printCollisions('SMALL_IMPACTS_START', true);
      break;

    case WayPoint.SMALL_IMPACTS_FINISH:
      this.printCollisions('SMALL_IMPACTS_FINISH', true);
      break;

    case WayPoint.SMALL_IMPACTS:
      this.myPrint('SMALL_IMPACTS'
          +' num collisions='+this.collisions_.length
          +' max impulse='+NF5E(this.maxImpulse(this.collisions_))
          +' min velocity='+NF7E(this.minVelocity(this.collisions_)));
      //this.myPrint(Util.arrayBool2string(this.jointFlags(this.collisions_)));
      //this.myPrint(Util.array2string(this.allVelocities(this.collisions_)));
      break;

    case WayPoint.BINARY_SEARCH_FAIL:
      this.myPrint('%cBINARY_SEARCH_FAIL%c turning off binary search'
          +', binarySteps_='+this.binarySteps_
          ,'background:#ffc', 'color:black');
      break;

    case WayPoint.NEXT_STEP_ESTIMATE:
      this.myPrint('NEXT_STEP_ESTIMATE'
          +' nextEstimate_='+NF7(this.nextEstimate_)
          +' currentStep_='+NF7E(this.currentStep_)
          +' numNeedsHandling='+this.stats_.numNeedsHandling
          +' stuckCount='+this.stuckCount_
      );
      break;

    case WayPoint.NEXT_STEP_BINARY:
      this.myPrint('%cNEXT_STEP_BINARY'
          +' currentStep_='+NF7E(this.currentStep_)
          +'%c detectedTime_='+NF7(this.detectedTime_)
          +' binarySteps_='+this.binarySteps_
          +' numNeedsHandling='+this.stats_.numNeedsHandling
          +' stuckCount_='+this.stuckCount_
          ,'background:#ffc', 'color:black');
      break;

    case WayPoint.NEXT_STEP_FULL:
      this.myPrint('NEXT_STEP_FULL'
          +' currentStep_='+NF7E(this.currentStep_)
          +' totalTimeStep_='+NF7(this.totalTimeStep_)
          +' timeAdvanced_='+NF7(this.timeAdvanced_)
          +' stuckCount_='+this.stuckCount_
      );
      break;

    case WayPoint.MAYBE_STUCK:
      this.myPrint('%cMAYBE_STUCK%c turning on binary search '
          +' stuckCount_='+this.stuckCount_
          +' nextEstimate_='+NF7(this.nextEstimate_)
          ,'background:#f9c', 'color:black');
      break;

    case WayPoint.ESTIMATE_IN_PAST:
      this.myPrint('%cESTIMATE_IN_PAST%c turning on binary search '
          +' nextEstimate_='+NF7(this.nextEstimate_)
          +' needsHandling='+this.stats_.numNeedsHandling
          ,'background:#f9c', 'color:black');
      break;

    case WayPoint.ESTIMATE_FAILED:
      this.myPrint('%cESTIMATE_FAILED%c turning on binary search '
          +' nextEstimate_='+NF7(this.nextEstimate_)
          +' needsHandling='+this.stats_.numNeedsHandling
          ,'background:#f9c', 'color:black');
      break;

    case WayPoint.NO_ESTIMATE:
      this.myPrint('%cNO_ESTIMATE%c turning on binary search '
          +' nextEstimate_='+NF7(this.nextEstimate_)
          +' needsHandling='+this.stats_.numNeedsHandling
          ,'background:#f9c', 'color:black');
      break;

    case WayPoint.SUMMARY:
      if (this.collisionCounter_>0 || this.backupCount_>0) {
        this.myPrint('**** SUMMARY handled '
            +this.collisionCounter_+' collisions; '
            +this.backupCount_+' backups; '
            +this.odeSteps_+' steps; '
            +this.collisionTotals_);
      }
      break;

    case WayPoint.FINISH:
      this.myPrint('=========  FINISH exiting advance '
          +' collisions='+this.collisionTotals_.getCollisions()
          +' steps='+this.collisionTotals_.getSteps());
      break;

    case WayPoint.STUCK:
      this.myPrint('STUCK collision was not resolved after '+this.stuckCount_
          +' tries');
      this.printCollisions('STUCK', true);
      // print history so we can reproduce the error
      console.log(this.sim_.getVarsList().printHistory());
      break;

    default:
      goog.asserts.fail();
  }
};

/** Prints a collision to console using color to highlight collisions that
are colliding or close enough to handle.
* @param {number} time current simulation time
* @param {string} msg message to print before the collision
* @param {!Collision} c the Collision to print
* @private
*/
CollisionAdvance.printCollision = function(time, msg, c) {
  var style = 'color:black'; // color corresponding to distance
  if (c.getVelocity() < 0) {
    if (c.isColliding()) {
      style = 'background:#fc6'; // orange
    } else if (c.closeEnough(/*allowTiny=*/true)) {
      style = 'background:#cf3'; // bright green
    }
  }
  console.log('%c'+NF7(time)+'%c '+msg+' %c'+c,
     'color:blue', 'color:black', style);
};

/** Print collisions, possibly leaving out joints and contacts.
* @param {string} msg message to print before each collision
* @param {boolean} printAll whether to print joint and contact collisions
* @private
*/
CollisionAdvance.prototype.printCollisions = function(msg, printAll) {
  if (Util.DEBUG) {
    var time = this.sim_.getTime();
    goog.array.forEach(this.collisions_, function(c, i) {
      if (printAll || c.needsHandling() || !c.contact()) {
        CollisionAdvance.printCollision(time, msg+' ['+i+']', c);
      }
    }, this);
  }
};

/** Print collisions that had impulse applied above the given minimal impulse size.
* @param {string} msg message to print before each collision
* @param {number} impulse minimum size of impulse
* @private
*/
CollisionAdvance.prototype.printCollisions2 = function(msg, impulse) {
  if (Util.DEBUG) {
    var time = this.sim_.getTime();
    goog.array.forEach(this.collisions_, function(c, i) {
      if (Math.abs(c.getImpulse()) > impulse) {
        CollisionAdvance.printCollision(time, msg+' ['+i+']', c);
      }
    }, this);
  }
};

/**
@return {undefined}
@private
*/
CollisionAdvance.prototype.printJointDistance = function() {
  var time = this.sim_.getTime();
  // avoid printing too often when using small time steps.
  // (Useful when comparing joint distance with small time steps to large time steps)
  if (time - this.printTime_ >= 0.025) {
    this.printTime_ = time;
    var joints = goog.array.filter(this.collisions_, function(c, index, array) {
      return c.bilateral();
    });
    var dists = goog.array.map(joints, function(c, index, array) {
      return c.getDistance();
    });
    this.myPrint(Util.array2string(dists));
  }
};

/** Removes from the current set of collisions, those contacts that are not touching,
because they cannot participate in the chain of impulses that are passed between
objects during serial collision handling. The removed collisions are added to the
removed collisions array.
@param {boolean} allowTiny regard as close enough collisions that have smaller distance
    than distance accuracy would normally allow
* @return {boolean} true if any collisions were removed
* @private
*/
CollisionAdvance.prototype.removeDistant = function(allowTiny) {
  var removed = false;
  // iterate backwards because we remove items from the list we are iterating over
  var i = this.collisions_.length;
  while (i-- > 0) {
    var c = this.collisions_[i];
    if (!c.isTouching()) {
      goog.array.removeAt(this.collisions_, i);
      this.removedCollisions_.push(c);
      removed = true;
    }
  }
  return removed;
};

/** @inheritDoc */
CollisionAdvance.prototype.reset = function() {
  this.sim_.reset();
  this.collisionTotals_.reset();
  this.printTime_ = Util.NEGATIVE_INFINITY;
};

/** Sets how much debugging information to show,
see {@link CollisionAdvance.DebugLevel}.
@param {!CollisionAdvance.DebugLevel} debugLevel specifies the
    groups of debug messages to show
*/
CollisionAdvance.prototype.setDebugLevel = function(debugLevel) {
  // display stack (for when you don't know who is setting debug level)
  //var e = new Error();
  //console.log('setDebugLevel '+debugLevel+' '+e.stack);
  switch (debugLevel) {
    case CollisionAdvance.DebugLevel.NONE:
      this.wayPoints_ = [WayPoint.STUCK];
      goog.asserts.assert(this.wayPoints_.length == 1);
      break;
    case CollisionAdvance.DebugLevel.LOW:
      this.wayPoints_ = [
          WayPoint.SUMMARY,
          WayPoint.STUCK
        ];
      break;
    case CollisionAdvance.DebugLevel.MEDIUM:
      this.wayPoints_ = [
          WayPoint.COLLISIONS_TO_HANDLE,
          WayPoint.HANDLE_REMOVE_DISTANT,
          WayPoint.HANDLE_COLLISION_SUCCESS,
          WayPoint.PRE_COLLISION,
          WayPoint.POST_COLLISION,
          WayPoint.STUCK
        ];
      break;
    case CollisionAdvance.DebugLevel.OPTIMAL:
      this.wayPoints_ = [
          WayPoint.ADVANCE_SIM_FAIL,
          WayPoint.ADVANCE_SIM_COLLIDING,
          WayPoint.POST_COLLISION,
          WayPoint.PRE_COLLISION,
          WayPoint.HANDLE_REMOVE_DISTANT,
          WayPoint.HANDLE_COLLISION_START,
          WayPoint.HANDLE_COLLISION_SUCCESS,
          WayPoint.HANDLE_COLLISION_FAIL,
          WayPoint.SMALL_IMPACTS,
          WayPoint.SMALL_IMPACTS_START,
          WayPoint.SMALL_IMPACTS_FINISH,
          WayPoint.BINARY_SEARCH_FAIL,
          WayPoint.NEXT_STEP_ESTIMATE,
          WayPoint.NEXT_STEP_BINARY,
          WayPoint.ESTIMATE_IN_PAST,
          WayPoint.ESTIMATE_FAILED,
          WayPoint.NO_ESTIMATE,
          WayPoint.MAYBE_STUCK,
          WayPoint.STUCK,
          WayPoint.SUMMARY
        ];
      break;
    case CollisionAdvance.DebugLevel.HIGH:
      this.wayPoints_ = [
          WayPoint.START,
          WayPoint.ADVANCED_NO_BACKUP,
          WayPoint.FINISH,
          WayPoint.ADVANCE_SIM_START,
          WayPoint.ADVANCE_SIM_FAIL,
          WayPoint.ADVANCE_SIM_COLLIDING,
          WayPoint.ADVANCE_SIM_FINISH,
          WayPoint.POST_COLLISION,
          WayPoint.PRE_COLLISION,
          WayPoint.HANDLE_REMOVE_DISTANT,
          WayPoint.HANDLE_COLLISION_START,
          WayPoint.HANDLE_COLLISION_SUCCESS,
          WayPoint.HANDLE_COLLISION_FAIL,
          WayPoint.SMALL_IMPACTS,
          WayPoint.SMALL_IMPACTS_START,
          WayPoint.SMALL_IMPACTS_FINISH,
          WayPoint.BINARY_SEARCH_FAIL,
          WayPoint.NEXT_STEP_ESTIMATE,
          WayPoint.NEXT_STEP_BINARY,
          WayPoint.NEXT_STEP_FULL,
          WayPoint.ESTIMATE_IN_PAST,
          WayPoint.ESTIMATE_FAILED,
          WayPoint.NO_ESTIMATE,
          WayPoint.MAYBE_STUCK,
          WayPoint.STUCK,
          WayPoint.SUMMARY
        ];
      break;
    case CollisionAdvance.DebugLevel.CUSTOM:
      // to do: be able to specify the customized set via setCustomWayPoints()
      this.wayPoints_ = [
          WayPoint.SMALL_IMPACTS
        ];
      break;
    default:
      goog.asserts.fail();
  }
};

/** For debugging, specify a function that will paint canvases, so that you can see the
simulation state while stepping thru with debugger.

### Why to use setDebugPaint()

Using `setDebugPaint()` allows you to see the sub-steps involved in calculating the next
simulation state, such as each collision happening over a time step, or the sub-steps
calculated by a {@link DiffEqSolver}. Normally you only see the
result after the next state is calculated, because the frame is painted after the
simulation has advanced by a certain time step. By setting the `paintAll` function and
setting a debugger break point you will be able to see the situation whenever
`moveObjects()` is called.  See {@link myphysicslab.lab.engine2D.RigidBodySim} for
an example and more information.

Here is example code where `simRun.paintAll` is the SimRunner method
{@link myphysicslab.lab.app.SimRunner#paintAll} which paints all the LabCanvas's.

    advance.setDebugPaint(goog.bind(simRun.paintAll, simRun));

@param {?function():undefined} fn function that will paint canvases
*/
CollisionAdvance.prototype.setDebugPaint = function(fn) {
  if (Util.DEBUG) {
    this.debugPaint_ = fn;
    if (0 == 1) {
      // Tell sim to also show intermediate states for more detailed debugging.
      // This is only useful when stepping with debugger thru sim methods.
      this.sim_.setDebugPaint(fn);
    }
  }
};

/** @inheritDoc */
CollisionAdvance.prototype.setDiffEqSolver = function(diffEqSolver) {
  this.odeSolver_ = diffEqSolver;
};

/** Sets whether to apply small impacts to joints to keep them aligned.
* @param {boolean} value `true` means apply small impacts to joints
*/
CollisionAdvance.prototype.setJointSmallImpacts = function(value) {
  this.jointSmallImpacts_ = value;
};

/** @inheritDoc */
CollisionAdvance.prototype.setTimeStep = function(timeStep) {
  this.timeStep_ = timeStep;
};

/** Specifies the group of WayPoints to show debug messages at.
* @param {!Array<!CollisionAdvance.WayPoint>} wayPoints  array
* of WayPoints to show debug messages for
*/
CollisionAdvance.prototype.setWayPoints = function(wayPoints) {
  this.wayPoints_ = goog.array.clone(wayPoints);
};

}); // goog.scope
