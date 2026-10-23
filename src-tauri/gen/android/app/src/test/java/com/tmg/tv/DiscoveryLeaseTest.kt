package com.tmg.tv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class DiscoveryLeaseTest {
  @Test fun overlappingDiscoveryIsBoundedAndLastOwnerReleases() {
    var acquired = 0; var released = 0
    val lease = DiscoveryLease({ acquired++ }, { released++ })
    repeat(4) { lease.begin("lease-$it", true) }
    assertEquals(1, acquired)
    assertThrows(IllegalStateException::class.java) { lease.begin("extra", true) }
    repeat(3) { lease.end("lease-$it") }
    assertEquals(0, released)
    lease.end("lease-3"); lease.end("lease-3")
    assertEquals(1, released)
  }

  @Test fun stoppedOwnerReleasesPromptlyAndLateBackgroundGrantCannotReacquire() {
    var foreground = true; var acquired = 0; var released = 0
    val lease = DiscoveryLease({ acquired++ }, { released++ })
    repeat(4) { lease.begin("lease-$it", foreground) }
    foreground = false
    lease.cancel(); lease.cancel()
    assertEquals(1, released)
    assertThrows(IllegalStateException::class.java) { lease.begin("new", foreground) }
    repeat(4) { lease.end("lease-$it") }
    assertEquals(1, acquired)
    assertEquals(1, released)
    foreground = true
    lease.begin("new", foreground); lease.end("new")
    assertEquals(2, acquired)
    assertEquals(2, released)
  }

  @Test fun failedAcquisitionDoesNotCreateAnOwnerAndFailedReleaseCanRetry() {
    var denyAcquire = true; var denyRelease = true; var released = 0
    val lease = DiscoveryLease({ if (denyAcquire) throw SecurityException() }, {
      if (denyRelease) throw SecurityException()
      released++
    })
    assertThrows(SecurityException::class.java) { lease.begin("extra", true) }
    lease.cancel()
    denyAcquire = false
    lease.begin("extra", true)
    assertThrows(SecurityException::class.java) { lease.cancel() }
    denyRelease = false
    lease.cancel(); lease.cancel(); lease.end("extra")
    assertEquals(1, released)
  }

  @Test fun oldReleaseCannotConsumeNewForegroundOwnership() {
    var acquired = 0; var released = 0
    val lease = DiscoveryLease({ acquired++ }, { released++ })
    lease.begin("old", true)
    lease.cancel()
    lease.begin("new", true)
    lease.begin("new", true)
    lease.end("old")
    assertEquals(2, acquired)
    assertEquals(1, released)
    lease.end("new")
    lease.end("new")
    assertEquals(2, released)
  }
}

